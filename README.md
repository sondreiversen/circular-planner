# Circular Planner — Go backend

A full-stack circular disc planner (Plandisc-style) with user accounts, data persistence, and sharing. This branch uses a **Go backend** that compiles to a single self-contained binary — no Node.js or database server needed in production.

> **Two backends are available:**
> - **This branch (`go-backend`)** — Go + SQLite (zero-config, single binary). Postgres supported via `DATABASE_URL`.
> - **[`main` branch](../../tree/main)** — Node.js + Express + TypeScript + PostgreSQL

---

## Why Go?

- **Single binary** — `go build` produces one executable that contains the server, all migrations, and the compiled frontend. Deploy by copying one file.
- **SQLite by default** — no database server to install or manage. The DB lives in `./data/planner.db`.
- **Postgres supported** — set `DATABASE_URL=postgres://...` and the binary switches drivers automatically.
- **No runtime dependencies** — no Node, no npm, no native modules on the host.
- **Long-term stability** — Go's standard library covers HTTP, crypto, JSON, and TLS. Minimal third-party surface area.

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

## Quick start

### Option A — Build from source

You need **Go 1.22+** and **npm** (to compile the TypeScript frontend).

```bash
git clone -b go-backend https://github.com/sondreiversen/circular-planner.git
cd circular-planner

# 1. Build the TypeScript frontend
npm install
npm run build:client        # outputs bundled JS to public/js/

# 2. Build the Go binary (embeds the compiled frontend)
go build -o planner .

# 3. Run
./planner
```

Open [http://localhost:3000](http://localhost:3000), register an account, and create your first planner.

The database is created automatically at `./data/planner.db`. No configuration required.

---

### Option B — Postgres instead of SQLite

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/circular_planner ./planner
```

The binary detects the driver from the URL prefix and runs all migrations automatically.

---

### Option C — Docker

```bash
docker compose up --build
```

Uses SQLite by default. To use Postgres, set `DATABASE_URL` in `.env` or the environment.

---

## Development (live reload)

To work on the frontend or backend without rebuilding the binary each time:

```bash
# Terminal 1 — watch the TypeScript frontend
npm run dev:client          # esbuild watch → public/js/

# Terminal 2 — run the Go server directly
go run .
```

Or run both together:

```bash
npm run dev
```

This starts the Node.js backend (for the Node version) on port 3000. To use the Go backend during development:

```bash
# Watch frontend + run Go server
npm run build:client && PORT=4000 go run .
```

---

## Configuration

All settings are read from environment variables. A `.env` file in the working directory is loaded automatically.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `sqlite:./data/planner.db` | Database URL. Use `postgres://...` for Postgres, `sqlite:/path/to/file.db` for SQLite. |
| `DATA_DIR` | `./data` | Directory for the SQLite database file (ignored when using Postgres) |
| `JWT_SECRET` | *(insecure default — change this)* | Secret for signing JWT tokens |
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

Example `.env`:

```env
JWT_SECRET=a-long-random-string
DATA_DIR=./data
PORT=3000
```

---

## Project structure

```
main.go              Go entry point — HTTP server, routing, embedded assets
internal/
  config/            Environment variable loading
  db/                DB wrapper (SQLite + Postgres), migration runner
  db/migrations/     SQL schema files (applied automatically on startup)
  middleware/        JWT auth, access control helpers
  auth/              /api/auth/* route handlers
  planners/          /api/planners/* route handlers
  share/             /api/planners/:id/shares/* route handlers
client/src/          Frontend TypeScript (D3.js) — shared with main branch
public/              Static HTML + CSS — embedded into the binary at build time
public/js/           Compiled JS bundles (generated by npm run build:client, gitignored)
```

---

## Migrating from the Node version

If you have an existing PostgreSQL database from the Node backend, the Go server will reuse it without any data loss. Point `DATABASE_URL` at the same Postgres instance — the Go migration runner uses its own `schema_migrations` table and the `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` clauses in each migration make them safe to apply on top of the existing schema.

There is no migration path from Postgres to SQLite. If you want to switch to SQLite, start fresh.

---

## Looking for the Node version?

Switch to the [`main` branch](../../tree/main) for the original Node.js + Express + PostgreSQL backend.
