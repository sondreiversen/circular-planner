# Circular Planner — Installation Guide

> This guide covers the **Node.js + PostgreSQL** backend on the `main` branch.
> For the zero-dependency Go + SQLite build, switch to the [`go-backend` branch](../../tree/go-backend) — it ships as a single self-contained binary and needs no Postgres.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Quick install (interactive script)](#2-quick-install-interactive-script)
3. [Manual Docker install](#3-manual-docker-install)
4. [Bare-metal install (no Docker)](#4-bare-metal-install-no-docker)
5. [Air-gapped install](#5-air-gapped-install)
6. [TLS / HTTPS](#6-tls--https)
7. [Reverse proxy (nginx / Caddy)](#7-reverse-proxy-nginx--caddy)
8. [GitLab SSO](#8-gitlab-sso)
9. [Managing users](#9-managing-users)
10. [Upgrading](#10-upgrading)
11. [Environment reference](#11-environment-reference)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites

### Docker install

| Requirement | Minimum version |
|---|---|
| Docker Engine | 24+ |
| Docker Compose plugin (`docker compose`) | v2 |
| `openssl` | any modern version |

### Bare-metal install

| Requirement | Minimum version |
|---|---|
| Node.js | 20 LTS |
| npm | 9+ (ships with Node 20) |
| PostgreSQL | 14+ |
| `openssl` | any modern version |

Neither install path requires root. The installer refuses to run as root.

---

## 2. Quick install (interactive script)

```bash
git clone https://github.com/sondreiversen/circular-planner.git
cd circular-planner
./install.sh
```

The script walks you through:

1. **Install mode** — Docker (default) or bare-metal Node + Postgres
2. **Admin credentials** — username, email, and password (≥ 8 characters)
3. **Postgres connection** — bare-metal only; Docker generates a random password

It then:
- Generates a cryptographically random `JWT_SECRET` (256-bit hex via `openssl rand`)
- Writes `.env` with `ALLOW_REGISTRATION=false` (no open sign-up by default)
- Builds the application and runs database migrations
- Creates the admin user account
- Verifies the app is reachable before finishing

Open [http://localhost:3000](http://localhost:3000) and sign in.

### If the installer fails

```bash
# Docker: inspect the container logs
docker compose logs app

# Check which step failed — the script prints a clear message and exits non-zero
```

---

## 3. Manual Docker install

### Step 1 — Create `.env`

```bash
cat > .env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
ALLOW_REGISTRATION=false
NODE_ENV=production
PORT=3000
EOF
```

`docker-compose.yml` requires both `JWT_SECRET` and `POSTGRES_PASSWORD`. The compose file will refuse to start if either is missing.

### Step 2 — Build and start

```bash
docker compose up -d --build
```

The `app` service waits for Postgres to pass its healthcheck before starting. Migrations run automatically on startup.

### Step 3 — Create the admin user

```bash
docker compose exec -T app npm run create-admin -- \
  --username admin \
  --email admin@example.com \
  --password 'change-me-now'
```

### Step 4 — Verify

```bash
curl -f http://localhost:3000/index.html && echo "OK"
```

### Useful commands

```bash
docker compose logs -f app          # stream app logs
docker compose ps                   # check container health
docker compose down                 # stop (data volume preserved)
docker compose down -v              # stop AND delete all data — irreversible
```

---

## 4. Bare-metal install (no Docker)

### Step 1 — Prepare the database

```sql
CREATE DATABASE circular_planner;
CREATE USER planner WITH PASSWORD 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON DATABASE circular_planner TO planner;
```

### Step 2 — Clone and configure

```bash
git clone https://github.com/sondreiversen/circular-planner.git
cd circular-planner

cat > .env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
DATABASE_URL=postgresql://planner:choose-a-strong-password@localhost:5432/circular_planner
ALLOW_REGISTRATION=false
NODE_ENV=production
PORT=3000
EOF
```

### Step 3 — Build

```bash
npm ci
npm run build
```

### Step 4 — Run migrations and seed admin

```bash
npm run create-admin -- \
  --username admin \
  --email admin@example.com \
  --password 'change-me-now'
```

`create-admin` runs migrations automatically on first run.

### Step 5 — Start

```bash
npm start
```

For long-running deployments use a process manager:

```bash
# systemd example
sudo systemctl edit --force --full circular-planner
```

```ini
[Unit]
Description=Circular Planner
After=network.target postgresql.service

[Service]
Type=simple
User=planner
WorkingDirectory=/opt/circular-planner
EnvironmentFile=/opt/circular-planner/.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now circular-planner
```

---

## 5. Air-gapped install

Use `package-airgap.sh` on an internet-connected machine to create a self-contained archive, then transfer and install it on the target.

### On the build machine (internet access required)

```bash
./package-airgap.sh
# Produces: circular-planner-airgap-YYYYMMDD.tar.gz
```

### On the target machine (no internet)

```bash
tar -xzf circular-planner-airgap-*.tar.gz
cd circular-planner-airgap-*/
./install-airgap.sh
```

The air-gapped installer follows the same interactive flow as `install.sh`. If Docker images are present in the archive it offers both Docker and bare-metal; otherwise it falls back to bare-metal automatically.

---

## 6. TLS / HTTPS

### Option A — Direct TLS (the app terminates TLS)

Add to `.env`:

```dotenv
TLS_CERT_FILE=/etc/ssl/certs/planner.crt
TLS_KEY_FILE=/etc/ssl/private/planner.key
HTTPS_PORT=3443
FORCE_HTTPS=true
```

The app starts an HTTPS listener on `HTTPS_PORT` and redirects all HTTP traffic from `PORT` to it. When `HTTPS_PORT=443`, the redirect URL omits the port suffix — no double-port in the URL.

### Option B — Reverse proxy terminates TLS (recommended for production)

Keep the app on HTTP internally and set:

```dotenv
TRUST_PROXY=true
FORCE_HTTPS=false
```

`TRUST_PROXY=true` tells Express to trust `X-Forwarded-*` headers from the proxy, which enables:
- Correct `Secure` attribute on auth cookies
- Real client IPs for rate limiting

See [Section 7](#7-reverse-proxy-nginx--caddy) for proxy configuration examples.

---

## 7. Reverse proxy (nginx / Caddy)

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name planner.example.com;

    ssl_certificate     /etc/ssl/certs/planner.crt;
    ssl_certificate_key /etc/ssl/private/planner.key;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name planner.example.com;
    return 301 https://$host$request_uri;
}
```

In `.env` set `TRUST_PROXY=true` and `FORCE_HTTPS=false`.

### Caddy

```caddyfile
planner.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy handles TLS automatically via Let's Encrypt. In `.env` set `TRUST_PROXY=true` and `FORCE_HTTPS=false`.

### Traefik (Docker)

Add labels to the `app` service in `docker-compose.yml`:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.planner.rule=Host(`planner.example.com`)"
  - "traefik.http.routers.planner.entrypoints=websecure"
  - "traefik.http.routers.planner.tls.certresolver=letsencrypt"
  - "traefik.http.services.planner.loadbalancer.server.port=3000"
```

---

## 8. GitLab SSO

To allow users to log in with a self-hosted GitLab instance:

1. In GitLab: **Admin Area → Applications → New application**
   - Name: `Circular Planner`
   - Redirect URI: `https://planner.example.com/api/auth/gitlab/callback`
   - Scopes: `read_user openid email`
   - Uncheck *Confidential* if users are logging in from browsers

2. Add to `.env`:

```dotenv
GITLAB_SSO_ENABLED=true
GITLAB_INSTANCE_URL=https://gitlab.example.com
GITLAB_CLIENT_ID=<application id>
GITLAB_CLIENT_SECRET=<application secret>
GITLAB_REDIRECT_URI=https://planner.example.com/api/auth/gitlab/callback
```

3. Restart the app. A **Sign in with GitLab** button appears on the login page.

GitLab users are automatically provisioned on first login. If `ALLOW_REGISTRATION=false`, GitLab SSO still works — it bypasses the local registration endpoint.

---

## 9. Managing users

### Create a user (any time)

```bash
# Docker
docker compose exec -T app npm run create-admin -- \
  --username alice \
  --email alice@example.com \
  --password 'strong-password'

# Bare-metal
npm run create-admin -- \
  --username alice \
  --email alice@example.com \
  --password 'strong-password'
```

Running without `--password` prompts interactively (stdin must be a TTY).

### Open registration

To allow anyone with the URL to register:

```dotenv
ALLOW_REGISTRATION=true
```

Restart the app after changing `.env`.

### Share a planner

From the planner page, click **Share** in the top toolbar. Enter the recipient's email address and choose **view** or **edit** access. The recipient must already have an account.

---

## 10. Upgrading

### Docker

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on startup. The advisory lock in the migration runner ensures only one instance applies each migration even if multiple containers start simultaneously.

### Bare-metal

```bash
git pull
npm ci
npm run build
npm start   # or: sudo systemctl restart circular-planner
```

Migrations run on startup. To run them separately first:

```bash
npm run migrate
```

### Rollback

The migration runner does not support automatic rollback. To roll back a migration:

1. Stop the app
2. Apply the inverse SQL manually via `psql`
3. Delete the row from the `migrations` table: `DELETE FROM migrations WHERE filename = '003-activity-labels.sql';`
4. Restart

---

## 11. Environment reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `JWT_SECRET` | — | **Yes** | Random string ≥ 32 characters. The installer generates one. |
| `DATABASE_URL` | `postgresql://localhost:5432/circular_planner` | Yes | Postgres connection string. |
| `PORT` | `3000` | No | HTTP port. |
| `NODE_ENV` | `development` | No | Set to `production` in deployments. |
| `ALLOW_REGISTRATION` | `true` | No | Set to `false` to disable the public register endpoint. Installer defaults to `false`. |
| `TRUST_PROXY` | `false` | No | Set to `true` behind a reverse proxy terminating TLS. Enables `Secure` cookies and correct client IPs. |
| `HTTPS_PORT` | `3443` | No | HTTPS listener port when TLS files are provided. |
| `TLS_CERT_FILE` | — | No | Path to TLS certificate file. |
| `TLS_KEY_FILE` | — | No | Path to TLS private key file. |
| `FORCE_HTTPS` | `true` | No | Redirect HTTP → HTTPS when TLS is active. Set to `false` when a proxy handles redirection. |
| `ALLOWED_ORIGIN` | `http://localhost:3000` | No | CORS allowed origin. Set to your public URL in production. |
| `GITLAB_SSO_ENABLED` | `false` | No | Enable GitLab OAuth2. |
| `GITLAB_INSTANCE_URL` | — | SSO only | GitLab base URL, e.g. `https://gitlab.example.com`. |
| `GITLAB_CLIENT_ID` | — | SSO only | GitLab OAuth2 application ID. |
| `GITLAB_CLIENT_SECRET` | — | SSO only | GitLab OAuth2 application secret. |
| `GITLAB_REDIRECT_URI` | — | SSO only | OAuth2 callback URL (must match GitLab app config). |
| `GITLAB_SCOPES` | `read_user openid email` | No | OAuth2 scopes to request. |

---

## 12. Troubleshooting

### App won't start: `FATAL: JWT_SECRET must be set`

`JWT_SECRET` is missing or shorter than 32 characters. Generate one:

```bash
openssl rand -hex 32
```

Add it to `.env` and restart.

### `POSTGRES_PASSWORD must be set` (Docker)

The compose file enforces this. Add `POSTGRES_PASSWORD=<random>` to `.env`.

### Migrations fail on startup

```bash
docker compose logs app   # or: journalctl -u circular-planner
```

Common causes:
- `DATABASE_URL` points to the wrong host or database
- Postgres is not yet ready (the compose file uses a healthcheck to wait, but bare-metal has no built-in wait)
- A previous migration left the database in a partial state — check the `migrations` table

### Can't log in after fresh install

Verify the admin user was created:

```bash
docker compose exec app node -e "
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
p.query('SELECT username, email FROM users').then(r => { console.table(r.rows); p.end(); });
"
```

If the table is empty, re-run `create-admin`.

### Port 3000 already in use

```bash
# Find what's using it
lsof -i :3000

# Or change the port
PORT=3001 npm start
# (or set PORT=3001 in .env)
```

### HTTPS redirect produces double port (e.g. `https://host:443:3443`)

Set `HTTPS_PORT=443` in `.env` when exposing port 443 directly, or use a reverse proxy and set `FORCE_HTTPS=false`.

### Outlook / Exchange calendar import fails

- Confirm the EWS endpoint URL ends in `/ews/exchange.asmx`
- For NTLM auth, the username must include the domain: `DOMAIN\user` or `user@domain.com`
- Self-signed certificates: enable **Allow self-signed certificate** in the import dialog
- Basic auth must be enabled on the Exchange server (it is disabled by default in newer Exchange)
- The import times out after 45 seconds total — if the Exchange server is slow, try again or increase the timeout in `server/ews/client.ts` (`NTLM_HANDSHAKE_TIMEOUT`)
