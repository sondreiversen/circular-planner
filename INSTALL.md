# Circular Planner — Installation Guide (Go backend)

> This guide covers the **Go + SQLite/Postgres** backend on the `go-backend` branch.
> The Go backend ships as a **single self-contained binary** with all static assets embedded — no Node.js, npm, or external runtime required at deploy time.
> For the Node.js + PostgreSQL build, see the [`main` branch](../../tree/main).

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
13. [Backups](#13-backups)
14. [Preflight check](#14-preflight-check)

---

## 1. Prerequisites

### Docker install

| Requirement | Minimum version |
|---|---|
| Docker Engine | 24+ |
| Docker Compose plugin (`docker compose`) | v2 |
| `openssl` | any modern version |

### Bare-metal install (build from source)

| Requirement | Minimum version |
|---|---|
| Go | 1.22+ |
| Node.js + npm | 20 LTS (build-time only — not needed at runtime) |
| `openssl` | any modern version |

### Bare-metal install (pre-built binary)

Only `openssl` is required — no other runtime dependencies. The binary embeds all static assets.

Neither install path requires root. The installer refuses to run as root.

---

## 2. Quick install (interactive script)

```bash
git clone -b go-backend https://github.com/sondreiversen/circular-planner.git
cd circular-planner
./install.sh
```

The script walks you through:

1. **Install mode** — Docker (default) or bare-metal binary
2. **Admin credentials** — username, email, and password (≥ 8 characters)
3. **Database** — SQLite (default, no config needed) or Postgres connection string

It then:
- Generates a cryptographically random `JWT_SECRET` (256-bit hex via `openssl rand`)
- Writes `.env` with `ALLOW_REGISTRATION=false` (no open sign-up by default)
- Runs database migrations automatically on first startup
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
ALLOW_REGISTRATION=false
PORT=3000
# SQLite by default — no DATABASE_URL needed
# For Postgres: DATABASE_URL=postgresql://user:pass@localhost:5432/circular_planner
EOF
```

`docker-compose.yml` requires `JWT_SECRET`. The compose file will refuse to start if it is missing.

### Step 2 — Build and start

```bash
docker compose up -d --build
```

The multi-stage Dockerfile compiles the Go binary with embedded frontend assets. Migrations run automatically on startup.

### Step 3 — Create the admin user

```bash
docker compose exec -T app ./planner --create-admin \
  --username admin \
  --email admin@example.com \
  --password 'change-me-now'
```

### Step 4 — Verify

```bash
curl -f http://localhost:3000/api/health && echo "OK"
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

### Option A — Pre-built binary (simplest)

Download or copy the pre-built `planner` binary for your platform (see the release archive or `package-airgap.sh`). Then:

```bash
mkdir -p ~/circular-planner/data
cp planner ~/circular-planner/

cat > ~/circular-planner/.env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
DATABASE_URL=sqlite:./data/planner.db
ALLOW_REGISTRATION=false
PORT=3000
EOF

cd ~/circular-planner
./planner --create-admin \
  --username admin \
  --email admin@example.com \
  --password 'change-me-now'

./planner   # start serving
```

### Option B — Build from source

```bash
git clone -b go-backend https://github.com/sondreiversen/circular-planner.git
cd circular-planner

# Build the frontend first (required — assets are embedded in the binary)
npm ci
npm run build:client

# Build the Go binary (embeds public/ at compile time)
go build -o planner .

cat > .env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
DATABASE_URL=sqlite:./data/planner.db
ALLOW_REGISTRATION=false
PORT=3000
EOF

./planner --create-admin \
  --username admin \
  --email admin@example.com \
  --password 'change-me-now'

./planner
```

### Using Postgres instead of SQLite

Set `DATABASE_URL` to a Postgres connection string. Create the database first:

```sql
CREATE DATABASE circular_planner;
CREATE USER planner WITH PASSWORD 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON DATABASE circular_planner TO planner;
```

Then in `.env`:

```dotenv
DATABASE_URL=postgresql://planner:choose-a-strong-password@localhost:5432/circular_planner
```

Migrations run automatically on startup regardless of which backend is used.

### Running as a systemd service

```bash
sudo systemctl edit --force --full circular-planner
```

```ini
[Unit]
Description=Circular Planner (Go backend)
After=network.target

[Service]
Type=simple
User=planner
WorkingDirectory=/opt/circular-planner
EnvironmentFile=/opt/circular-planner/.env
ExecStart=/opt/circular-planner/planner
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

The archive contains a statically-linked `planner` binary with all frontend assets embedded — no npm, Node, or network access needed on the target machine.

### On the build machine (internet access)

```bash
./package-airgap.sh
# Produces: circular-planner-airgap-YYYYMMDD.tar.gz

# To skip Docker image export (smaller archive, bare-metal only):
./package-airgap.sh --skip-docker

# To include Postgres image:
./package-airgap.sh --with-postgres

# To cross-compile for a different architecture:
./package-airgap.sh --platform linux/amd64
```

### On the target machine (no internet)

```bash
tar -xzf circular-planner-airgap-*.tar.gz
cd circular-planner-airgap-*/
./install-airgap.sh
```

The installer will:
1. Offer **Docker** (option 1, default) or **bare-metal** (option 2).
2. Walk through admin account creation.
3. Copy the `scripts/` directory (backup, restore, doctor) alongside the binary.
4. Run a preflight check via `./scripts/doctor.sh` after install completes (non-fatal — WARN/FAIL output is shown for operator review).

### Managing the bare-metal service

```bash
sudo systemctl status  circular-planner
sudo systemctl restart circular-planner
sudo systemctl stop    circular-planner
sudo journalctl -u circular-planner -f
```

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

The app starts an HTTPS listener on `HTTPS_PORT` and redirects all HTTP traffic from `PORT` to it. When `HTTPS_PORT=443`, the redirect URL omits the port suffix.

### Option B — Reverse proxy terminates TLS (recommended for production)

Keep the app on HTTP internally and set:

```dotenv
TRUST_PROXY=true
FORCE_HTTPS=false
```

`TRUST_PROXY=true` enables `Secure` cookies and correct client IPs for rate limiting.

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
docker compose exec -T app ./planner --create-admin \
  --username alice \
  --email alice@example.com \
  --password 'strong-password'

# Bare-metal
./planner --create-admin \
  --username alice \
  --email alice@example.com \
  --password 'strong-password'
```

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

Skim [CHANGELOG.md](CHANGELOG.md) before upgrading to see operator-visible changes that may require action.

### Docker

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on startup.

### Bare-metal (from source)

```bash
git pull
npm run build:client   # rebuild frontend assets
go build -o planner .  # recompile binary (embeds updated assets)
sudo systemctl restart circular-planner   # or: ./planner
```

Migrations run automatically on startup. To check migration status first:

```bash
./planner migrate status
```

### Rollback

The migration runner does not support automatic rollback. To roll back a SQLite migration:

1. Stop the app (`sudo systemctl stop circular-planner`)
2. Restore from a backup (`./scripts/restore.sh --yes /path/to/backup.sqlite`)
3. Restart

For Postgres:
1. Stop the app
2. Apply the inverse SQL manually via `psql`
3. Delete the row from `schema_migrations` table
4. Restart

---

## 11. Environment reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `JWT_SECRET` | — | **Yes** | Random string ≥ 32 characters. The installer generates one. |
| `DATABASE_URL` | `sqlite:./data/planner.db` | No | SQLite path (`sqlite:<path>`) or Postgres URL (`postgresql://...`). |
| `DATA_DIR` | `./data` | No | SQLite data directory (SQLite only). |
| `PORT` | `3000` | No | HTTP port. |
| `ALLOW_REGISTRATION` | `true` | No | Set to `false` to disable the public register endpoint. Installer defaults to `false`. |
| `TRUST_PROXY` | `false` | No | Set to `true` behind a reverse proxy terminating TLS. |
| `HTTPS_PORT` | `3443` | No | HTTPS listener port when TLS files are provided. |
| `TLS_CERT_FILE` | — | No | Path to TLS certificate file. |
| `TLS_KEY_FILE` | — | No | Path to TLS private key file. |
| `FORCE_HTTPS` | `true` | No | Redirect HTTP → HTTPS when TLS is active. Set to `false` when a proxy handles redirection. |
| `GITLAB_SSO_ENABLED` | `false` | No | Enable GitLab OAuth2. |
| `GITLAB_INSTANCE_URL` | — | SSO only | GitLab base URL. |
| `GITLAB_CLIENT_ID` | — | SSO only | GitLab OAuth2 application ID. |
| `GITLAB_CLIENT_SECRET` | — | SSO only | GitLab OAuth2 application secret. |
| `GITLAB_REDIRECT_URI` | — | SSO only | OAuth2 callback URL (must match GitLab app config). |
| `APP_NAME` | `Circular Planner` | No | Customize the application name shown in the UI. |
| `APP_LOGO_URL` | — | No | URL to a custom logo image for white-label deployments. |

---

## 12. Troubleshooting

### App won't start: `FATAL: JWT_SECRET must be set`

`JWT_SECRET` is missing or shorter than 32 characters. Generate one:

```bash
openssl rand -hex 32
```

Add it to `.env` and restart.

### Migrations fail on startup

```bash
docker compose logs app   # or: journalctl -u circular-planner
./planner migrate status  # check migration state
```

Common causes:
- `DATABASE_URL` points to the wrong path or host
- SQLite data directory does not exist or is not writable — ensure `DATA_DIR` exists
- A previous migration left the database in a partial state — check the `schema_migrations` table

### Can't log in after fresh install

Verify the admin user was created. For SQLite:

```bash
sqlite3 ./data/planner.db "SELECT username, email FROM users;"
```

If the table is empty, re-run `./planner --create-admin`.

### Port 3000 already in use

```bash
lsof -i :3000

# Or change the port
PORT=3001 ./planner
# (or set PORT=3001 in .env)
```

### HTTPS redirect produces double port

Set `HTTPS_PORT=443` in `.env` when exposing port 443 directly, or use a reverse proxy and set `FORCE_HTTPS=false`.

### Outlook / Exchange calendar import fails

- Confirm the EWS endpoint URL ends in `/ews/exchange.asmx`
- For NTLM auth, the username must include the domain: `DOMAIN\user` or `user@domain.com`
- Self-signed certificates: enable **Allow self-signed certificate** in the import dialog
- Basic auth must be enabled on the Exchange server
- The import times out after 45 seconds total across all NTLM round-trips (`NTLM_HANDSHAKE_TIMEOUT` in `internal/ews/client.go`)

---

## 13. Backups

### SQLite (default)

The Go backend uses SQLite in WAL mode by default. There are two safe backup approaches:

**Recommended (while running): `sqlite3 .backup`**

`scripts/backup.sh` uses `sqlite3`'s `.backup` command when available, which produces a clean, consistent copy even if a WAL transaction is in progress:

```bash
BACKUP_DIR=/var/backups/planner ./scripts/backup.sh
```

**Fallback (if `sqlite3` CLI not installed): `cp` with WAL files**

`scripts/backup.sh` falls back to `cp`. In this case it copies the `.db`, `.db-wal`, and `.db-shm` files together. **For a fully consistent copy, stop the binary first** (`sudo systemctl stop circular-planner`) so WAL is checkpointed before copying.

**Safest: stop, copy, restart**

```bash
sudo systemctl stop circular-planner
cp ./data/planner.db /var/backups/planner/planner-$(date +%Y%m%d).sqlite
sudo systemctl start circular-planner
```

### Postgres

`scripts/backup.sh` automatically uses `pg_dump` when `DATABASE_URL` starts with `postgres`:

```bash
BACKUP_DIR=/var/backups/planner ./scripts/backup.sh
```

**Environment variables**

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `sqlite:./data/planner.db` | Full connection string. Controls whether SQLite or Postgres path is used. |
| `BACKUP_DIR` | `./data/backups` | Directory to write backup files. |
| `BACKUP_RETENTION_DAYS` | `14` | Backups older than this many days are deleted. |

**Cron example** (daily at 02:00, keep 30 days):

```cron
0 2 * * * BACKUP_DIR=/var/backups/planner BACKUP_RETENTION_DAYS=30 /opt/planner/scripts/backup.sh >> /var/log/planner-backup.log 2>&1
```

### `scripts/restore.sh`

Restores from a backup. Always takes a pre-restore safety dump first.

```bash
# SQLite
./scripts/restore.sh --yes /var/backups/planner/planner-20260101-020000.sqlite

# Postgres
./scripts/restore.sh --yes /var/backups/planner/planner-20260101-020000.dump
```

The `--yes` flag is required to confirm the destructive restore. **Stop the Go binary before restoring a SQLite database** — the script will prompt you to confirm the service is stopped.

---

## 14. Preflight check

`scripts/doctor.sh` runs a series of checks and prints a human-readable summary.

```bash
./scripts/doctor.sh
```

**Sample output**

```
Circular Planner — preflight check (Go backend)

[PASS]  planner binary                Found: ./planner
[PASS]  JWT_SECRET                    Set (64 chars)
[PASS]  DB reachable                  Connected successfully
[PASS]  Pending migrations            All migrations applied
[SKIP]  Postgres connections          Not Postgres (DATABASE_URL is SQLite or unknown)
[PASS]  Disk (DATA_DIR)               42 GB free in ./data
[SKIP]  Disk (BACKUP_DIR)             BACKUP_DIR not set

  7 check(s): 4 passed, 0 warned, 0 failed, 3 skipped
```

Exit code `0` if no FAIL; `1` if any FAIL.

**Checks performed**

| Check | FAIL condition | WARN condition | SKIP condition |
|---|---|---|---|
| `planner` binary | — | Not found in `./` or `$INSTALL_DIR` | — |
| `JWT_SECRET` | Not set or < 32 chars | — | — |
| DB reachable | Cannot connect (`./planner migrate status` fails) | — | Binary not found |
| Pending migrations | — | `migrate status` shows pending | Binary not found or DB down |
| Postgres connections | — | > 80% of `max_connections` used | Not Postgres, or `psql` not installed |
| Disk (`DATA_DIR`) | — | < 1 GB free | — |
| Disk (`BACKUP_DIR`) | — | < 1 GB free | `BACKUP_DIR` not set |

Run `./scripts/doctor.sh` as part of your deployment checklist or from a monitoring cron job.
