# Circular Planner — Node.js backend

A full-stack circular disc planner (Plandisc-style) with user accounts, data persistence, and sharing. Built with TypeScript, D3.js, Node.js, and PostgreSQL.

> **Two backends are available:**
> - **This branch (`main`)** — Node.js + Express + TypeScript + PostgreSQL
> - **[`go-backend` branch](../../tree/go-backend)** — Go + SQLite (zero-config, single binary). No Postgres required.

---

## Features

- Circular disc visualisation across **Year / Quarter / Month / Week** zoom levels
- Day sub-ticks within each month sector at Year zoom
- Drag-to-reorder lanes; hidden lanes release their ring slot automatically
- Per-activity colour, label, and description
- Label filter and keyword search
- Dark mode (persisted in `localStorage`)
- Planner sharing with view or edit permissions
- GitLab SSO (optional)
- TLS support

---

## Requirements

- **Node.js 20+** and **npm**
- **PostgreSQL 14+**

---

## Quick start

```bash
git clone https://github.com/sondreiversen/circular-planner.git
cd circular-planner
./install.sh
```

The interactive installer handles both **Docker** and **bare-metal** setups, generates secrets, runs migrations, and seeds the admin user.

Open [http://localhost:3000](http://localhost:3000) and sign in.

**Full installation guide** — Docker, bare-metal, air-gapped, TLS, reverse proxy, GitLab SSO, upgrading, and troubleshooting: **[INSTALL.md](INSTALL.md)**

---

## Development

```bash
npm run dev
```

Starts the Node server (auto-restarting via `nodemon`) and `esbuild` in watch mode concurrently. Changes to server or frontend code reload automatically.

Other commands:

```bash
npm run build:client   # bundle frontend only (outputs to public/js/)
npm run build:server   # compile server TypeScript only
npm test               # Jest frontend unit tests
npm run migrate        # run database migrations manually
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://localhost:5432/circular_planner` | Postgres connection string |
| `JWT_SECRET` | *(required — installer generates one)* | Secret for signing JWT tokens |
| `ALLOW_REGISTRATION` | `true` | Set to `false` to disable public `/register` (installer defaults to `false`) |
| `TRUST_PROXY` | `false` | Set to `true` when behind a reverse proxy terminating TLS (enables correct `Secure` cookies and client IPs for rate limiting) |
| `PORT` | `3000` | HTTP port |
| `HTTPS_PORT` | `3443` | HTTPS port (requires TLS config below) |
| `TLS_CERT_FILE` | — | Path to TLS certificate |
| `TLS_KEY_FILE` | — | Path to TLS private key |
| `FORCE_HTTPS` | `true` | Redirect HTTP → HTTPS when TLS is active |
| `GITLAB_SSO_ENABLED` | `false` | Enable GitLab OAuth2 login |
| `GITLAB_INSTANCE_URL` | — | GitLab base URL, e.g. `https://gitlab.example.com` |
| `GITLAB_CLIENT_ID` | — | GitLab OAuth2 application ID |
| `GITLAB_CLIENT_SECRET` | — | GitLab OAuth2 application secret |
| `GITLAB_REDIRECT_URI` | — | OAuth2 callback URL |
| `GITLAB_SCOPES` | `read_user openid email` | OAuth2 scopes to request |

---

## Security & deployment

- **HTTPS is required in production.** Either point the app at a certificate directly with `TLS_CERT_FILE` + `TLS_KEY_FILE`, or run behind a reverse proxy (nginx, Caddy, Traefik) that terminates TLS and set `TRUST_PROXY=true` so the app issues `Secure` cookies and sees real client IPs.
- **Cookie-based auth.** Login sets an `HttpOnly` `Secure` `SameSite=Lax` cookie named `cp_token`. Tokens are no longer stored in `localStorage`. The JSON response still returns the token for non-browser API clients. `POST /api/auth/logout` clears the cookie.
- **Registration control.** `ALLOW_REGISTRATION=false` disables the public `/register` endpoint — the installer sets this by default. Create additional users with `npm run create-admin -- --username alice --email alice@example.com --password '...'` (runs interactively if stdin is a TTY).
- **Rate limiting.** `/api/auth/login` and `/api/auth/register` are limited to 20 requests per 15 minutes per IP. `helmet` is enabled for standard security headers.
- **Admin creation.** After a fresh install, `npm run create-admin` is the supported way to add users when registration is disabled.

---

## Project structure

```
server/              Node.js + Express backend (TypeScript)
  routes/            auth, planners, shares
  migrations/        SQL schema (applied automatically on startup)
  middleware/        JWT auth, access control
client/src/          Frontend TypeScript (D3.js)
public/              Static HTML + CSS
public/js/           Compiled JS bundles (generated, gitignored)
```

---

## Looking for the Go version?

Switch to the [`go-backend` branch](../../tree/go-backend) for a rewrite that:

- Compiles to a **single self-contained binary** (no Node, no npm in production)
- Uses **SQLite by default** — no Postgres needed to get started
- Still supports Postgres by setting `DATABASE_URL=postgres://...`
- Embeds the compiled frontend inside the binary — one file to deploy
