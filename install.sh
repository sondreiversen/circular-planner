#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo "============================================"
echo "   Circular Planner — Installation Script"
echo "============================================"
echo ""

# Refuse to run as root
if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  echo -e "${RED}ERROR: Do not run this script as root.${NC}"
  exit 1
fi

# ── Install mode ────────────────────────────────────────────────────────────
echo "How would you like to install?"
echo "  1) Docker  (recommended — no local dependencies needed)"
echo "  2) Bare-metal  (Go + Node.js on this machine)"
echo ""
read -rp "Choice [1/2, default 1]: " INSTALL_MODE
INSTALL_MODE="${INSTALL_MODE:-1}"

# ── Admin credentials ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Create the initial admin account:${NC}"
read -rp "  Admin username: " ADMIN_USER
read -rp "  Admin email:    " ADMIN_EMAIL
while true; do
  read -rsp "  Admin password (min 8 chars): " ADMIN_PASS; echo ""
  [ "${#ADMIN_PASS}" -ge 8 ] && break
  echo -e "${RED}  Password must be at least 8 characters.${NC}"
done

# ── .env handling ────────────────────────────────────────────────────────────
JWT_SECRET=$(openssl rand -hex 32)

write_env() {
  if [ -f .env ]; then
    read -rp ".env already exists — overwrite? [y/N] " OW
    [[ "${OW,,}" == "y" ]] || { echo -e "${YELLOW}Keeping existing .env${NC}"; return; }
  fi
  cat > .env <<EOF
$1
EOF
  echo -e "${GREEN}✓ .env written${NC}"
}

# ════════════════════════════════════════════════════════════════════════════
# 1 — DOCKER PATH
# ════════════════════════════════════════════════════════════════════════════
if [ "$INSTALL_MODE" = "1" ]; then
  command -v docker &>/dev/null   || { echo -e "${RED}ERROR: docker not found.${NC}"; exit 1; }
  docker compose version &>/dev/null || { echo -e "${RED}ERROR: 'docker compose' plugin not found.${NC}"; exit 1; }
  echo -e "${GREEN}✓ Docker found${NC}"

  write_env "JWT_SECRET=${JWT_SECRET}
ALLOW_REGISTRATION=false
NODE_ENV=production
PORT=3000"

  echo ""
  echo "Building and starting containers…"
  docker compose up -d --build

  echo "Waiting for app to be ready…"
  for i in $(seq 1 60); do
    curl -fsS "http://localhost:${PORT:-3000}/index.html" &>/dev/null && break
    [ "$i" -eq 60 ] && { echo -e "${RED}ERROR: App did not start within 60s.${NC}"; exit 1; }
    sleep 1
  done
  echo -e "${GREEN}✓ App is up${NC}"

  echo ""
  echo "Seeding admin user…"
  docker compose exec -T app ./planner admin create \
    --username "$ADMIN_USER" --email "$ADMIN_EMAIL" --password "$ADMIN_PASS"

# ════════════════════════════════════════════════════════════════════════════
# 2 — BARE-METAL PATH
# ════════════════════════════════════════════════════════════════════════════
else
  # Check Go
  command -v go &>/dev/null || { echo -e "${RED}ERROR: go not found. Install Go 1.22+ from https://go.dev/dl/${NC}"; exit 1; }
  GO_MINOR=$(go version | grep -oE 'go[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | cut -d. -f2)
  [ "${GO_MINOR:-0}" -ge 22 ] || { echo -e "${RED}ERROR: Go 1.22+ required (found $(go version)).${NC}"; exit 1; }
  echo -e "${GREEN}✓ $(go version)${NC}"

  # Check Node (needed to build the frontend)
  command -v node &>/dev/null || { echo -e "${RED}ERROR: Node.js not found (needed to build frontend).${NC}"; exit 1; }
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  [ "${NODE_VER:-0}" -ge 18 ] || { echo -e "${RED}ERROR: Node.js 18+ required.${NC}"; exit 1; }
  echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

  # Database selection
  echo ""
  echo "Database backend:"
  echo "  1) SQLite  (default — zero config, stored in ./data/planner.db)"
  echo "  2) PostgreSQL  (provide a connection URL)"
  read -rp "Choice [1/2, default 1]: " DB_CHOICE
  DB_CHOICE="${DB_CHOICE:-1}"

  if [ "$DB_CHOICE" = "2" ]; then
    read -rp "PostgreSQL DATABASE_URL (postgresql://user:pass@host/db): " DATABASE_URL
    # Test connection
    if command -v psql &>/dev/null; then
      psql "$DATABASE_URL" -c 'SELECT 1' &>/dev/null || {
        echo -e "${YELLOW}Could not connect. You may need to create the database first:${NC}"
        echo ""
        echo "  CREATE DATABASE circular_planner;"
        echo "  CREATE USER planner WITH PASSWORD 'yourpassword';"
        echo "  GRANT ALL PRIVILEGES ON DATABASE circular_planner TO planner;"
        echo ""
        read -rp "Press Enter to retry after creating the database, or Ctrl-C to abort…" _
        psql "$DATABASE_URL" -c 'SELECT 1' &>/dev/null || { echo -e "${RED}Still cannot connect. Aborting.${NC}"; exit 1; }
      }
      echo -e "${GREEN}✓ Postgres connection OK${NC}"
    fi
  else
    DATABASE_URL="sqlite:./data/planner.db"
    mkdir -p data
    echo -e "${GREEN}✓ Using SQLite at ./data/planner.db${NC}"
  fi

  write_env "DATABASE_URL=${DATABASE_URL}
JWT_SECRET=${JWT_SECRET}
ALLOW_REGISTRATION=false
NODE_ENV=production
PORT=3000"

  echo ""
  echo "Installing frontend dependencies…"
  npm ci --silent

  echo "Building frontend…"
  npm run build:client

  echo "Building Go binary…"
  go build -o planner .
  echo -e "${GREEN}✓ Build complete${NC}"

  echo ""
  echo "Seeding admin user (migrations run automatically)…"
  ./planner admin create \
    --username "$ADMIN_USER" --email "$ADMIN_EMAIL" --password "$ADMIN_PASS"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
PORT="${PORT:-3000}"
echo ""
echo -e "${GREEN}${BOLD}============================================${NC}"
echo -e "${GREEN}${BOLD}   Installation complete!${NC}"
echo -e "${GREEN}${BOLD}============================================${NC}"
echo ""
echo -e "  URL:      ${BOLD}http://localhost:${PORT}${NC}"
echo -e "  Admin:    ${BOLD}${ADMIN_USER}${NC}"
echo ""
echo -e "  ${YELLOW}Registration is closed.${NC} Set ALLOW_REGISTRATION=true in .env to reopen."
echo ""
echo -e "  ${YELLOW}HTTPS:${NC} Set TLS_CERT_FILE + TLS_KEY_FILE in .env,"
echo -e "         or run behind a reverse proxy and set TRUST_PROXY=true."
echo ""
if [ "$INSTALL_MODE" = "2" ]; then
  echo -e "  To start: ${BOLD}./planner${NC}"
  echo ""
fi
