#!/usr/bin/env bash
# Circular Planner — air-gapped deployment packager (Go backend)
# Run this on an internet-connected machine to produce a self-contained archive
# that can be transferred to and installed on a network with no internet access.
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}$*${NC}"; }
warn()  { echo -e "${YELLOW}$*${NC}"; }
err()   { echo -e "${RED}$*${NC}" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "ERROR: required command '$1' not found."; exit 1; }
}

# ─── Parse flags ──────────────────────────────────────────────────────────────
PLATFORM=""
SKIP_DOCKER=false
WITH_POSTGRES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)      PLATFORM="$2"; shift 2 ;;
    --skip-docker)   SKIP_DOCKER=true; shift ;;
    --with-postgres) WITH_POSTGRES=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--platform linux/amd64] [--skip-docker] [--with-postgres]"
      echo ""
      echo "  --platform ARCH   Docker platform (e.g. linux/amd64). Also sets GOOS/GOARCH"
      echo "                    for the bare-metal binary."
      echo "  --skip-docker     Do not build or save Docker images (bare-metal only)."
      echo "  --with-postgres   Include postgres:16-alpine in the archive. Default is"
      echo "                    SQLite-only (the Go backend's default)."
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# ─── Prerequisites ────────────────────────────────────────────────────────────
require node
require npm
require go

if [ "$SKIP_DOCKER" = false ]; then
  require docker
  if ! docker compose version >/dev/null 2>&1; then
    err "ERROR: 'docker compose' (v2 plugin) not available."
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "ERROR: Docker daemon is not running."
    exit 1
  fi
fi

# ─── Constants ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION=$(node -p "require('${SCRIPT_DIR}/package.json').version")
DATE=$(date +%Y%m%d)
GIT_HASH=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
ARCHIVE_NAME="circular-planner-airgap-${VERSION}-${DATE}"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

PLATFORM_FLAG=""
GOOS_FLAG=""
GOARCH_FLAG=""
if [ -n "$PLATFORM" ]; then
  PLATFORM_FLAG="--platform $PLATFORM"
  # Split "linux/amd64" → GOOS=linux, GOARCH=amd64
  GOOS_FLAG="${PLATFORM%%/*}"
  GOARCH_FLAG="${PLATFORM##*/}"
fi

echo ""
echo "============================================"
echo "   Circular Planner — Air-Gap Packager"
echo "   (Go backend)"
echo "============================================"
echo ""
echo "  Version:  ${VERSION}"
echo "  Commit:   ${GIT_HASH}"
echo "  Platform: ${PLATFORM:-$(uname -s)/$(uname -m) (host default)}"
echo "  Postgres: $([ "$WITH_POSTGRES" = true ] && echo yes || echo "no (SQLite default)")"
echo ""

# ─── Step 1: Build frontend ───────────────────────────────────────────────────
info "[1/5] Building frontend bundles..."
cd "$SCRIPT_DIR"
npm ci --ignore-scripts=false
npm run build:client

# ─── Step 2: Build Go binary ──────────────────────────────────────────────────
info "[2/5] Building Go binary..."
BIN_OUT="$STAGING/$ARCHIVE_NAME/bare-metal/planner"
mkdir -p "$(dirname "$BIN_OUT")"

BUILD_ENV=(CGO_ENABLED=0)
if [ -n "$GOOS_FLAG" ]; then
  BUILD_ENV+=("GOOS=${GOOS_FLAG}" "GOARCH=${GOARCH_FLAG}")
fi
env "${BUILD_ENV[@]}" go build -trimpath -ldflags "-s -w" -o "$BIN_OUT" .
chmod +x "$BIN_OUT"

# Example .env
cat > "$STAGING/$ARCHIVE_NAME/bare-metal/.env.example" <<'EOF'
# Circular Planner — bare-metal example environment
# Copy to .env and edit. JWT_SECRET must be set.
PORT=3000
JWT_SECRET=CHANGE_ME_hex32_openssl_rand
DATABASE_URL=sqlite:./data/planner.db
# For Postgres, use:
# DATABASE_URL=postgresql://user:pass@localhost:5432/circular_planner
EOF

# ─── Step 3: Docker images ────────────────────────────────────────────────────
if [ "$SKIP_DOCKER" = false ]; then
  info "[3/5] Building and saving Docker images..."
  mkdir -p "$STAGING/$ARCHIVE_NAME/images"

  # Build the app image from source (uses the multi-stage Dockerfile in the repo).
  docker build $PLATFORM_FLAG -t circular-planner:latest "$SCRIPT_DIR"

  info "  Saving circular-planner:latest..."
  docker save circular-planner:latest -o "$STAGING/$ARCHIVE_NAME/images/circular-planner-app.tar"

  if [ "$WITH_POSTGRES" = true ]; then
    docker pull $PLATFORM_FLAG postgres:16-alpine
    info "  Saving postgres:16-alpine..."
    docker save postgres:16-alpine -o "$STAGING/$ARCHIVE_NAME/images/postgres-16-alpine.tar"
  fi

  # Generate docker-compose.airgap.yml (use the saved app image, not build:).
  if [ "$WITH_POSTGRES" = true ]; then
    cat > "$STAGING/$ARCHIVE_NAME/docker-compose.airgap.yml" <<'EOF'
version: '3.8'
services:
  app:
    image: circular-planner:latest
    restart: unless-stopped
    ports:
      - "${PORT:-3000}:3000"
    environment:
      DATABASE_URL: postgresql://planner:${POSTGRES_PASSWORD}@db:5432/circular_planner
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET must be set in .env}
      PORT: 3000
    depends_on:
      - db
    volumes:
      - planner-data:/home/planner/data
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: planner
      POSTGRES_DB: circular_planner
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}
    volumes:
      - pg-data:/var/lib/postgresql/data
volumes:
  planner-data:
  pg-data:
EOF
  else
    # SQLite variant (default) — no db service needed.
    sed 's|^    build: \.$|    image: circular-planner:latest|' \
      "$SCRIPT_DIR/docker-compose.yml" \
      > "$STAGING/$ARCHIVE_NAME/docker-compose.airgap.yml"
  fi
else
  info "[3/5] Skipping Docker images (--skip-docker)"
fi

# ─── Step 4: Installer + build info ──────────────────────────────────────────
info "[4/5] Writing build info and installer..."
cp "$SCRIPT_DIR/install-airgap.sh" "$STAGING/$ARCHIVE_NAME/"
chmod +x "$STAGING/$ARCHIVE_NAME/install-airgap.sh"

cat > "$STAGING/$ARCHIVE_NAME/BUILD_INFO" <<EOF
Circular Planner — Air-Gapped Deployment Package (Go backend)
=============================================================
Version:      ${VERSION}
Git commit:   ${GIT_HASH}
Packaged:     $(date -u +%Y-%m-%dT%H:%M:%SZ)
Go:           $(go version)
Node.js:      $(node -v)
Platform:     $(uname -s) $(uname -m)${PLATFORM:+ → built for ${PLATFORM}}
Docker:       $(docker --version 2>/dev/null || echo "n/a")
Postgres:     $([ "$WITH_POSTGRES" = true ] && echo "bundled" || echo "not bundled (SQLite default)")

Contents:
  bare-metal/        Statically-linked 'planner' binary + .env.example
  images/            Docker images (app, and optionally postgres) as tar archives
  docker-compose.airgap.yml  Compose file for the Docker path
  install-airgap.sh  Interactive installer for the target machine

Note: The binary is a single statically-linked executable with all static
assets embedded. Deploy by copying 'planner' and running it — no runtime
dependencies required.
EOF

# ─── Step 5: Archive ──────────────────────────────────────────────────────────
info "[5/5] Creating archive..."
tar -czf "$SCRIPT_DIR/${ARCHIVE_NAME}.tar.gz" -C "$STAGING" "$ARCHIVE_NAME"

ARCHIVE_SIZE=$(du -h "$SCRIPT_DIR/${ARCHIVE_NAME}.tar.gz" | cut -f1)

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}   Archive created successfully!${NC}"
echo -e "${GREEN}============================================${NC}"
echo "  File: ${ARCHIVE_NAME}.tar.gz"
echo "  Size: ${ARCHIVE_SIZE}"
echo ""
echo "Transfer this file to the air-gapped network, then run:"
echo ""
echo "  tar -xzf ${ARCHIVE_NAME}.tar.gz"
echo "  cd ${ARCHIVE_NAME}"
echo "  ./install-airgap.sh"
echo ""
