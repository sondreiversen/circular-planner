#!/usr/bin/env bash
# Circular Planner — air-gapped deployment packager
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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)   PLATFORM="$2"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--platform linux/amd64] [--skip-docker]"
      echo ""
      echo "  --platform ARCH   Docker platform (default: current host)"
      echo "  --skip-docker     Skip Docker image export (bare-metal only archive)"
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# ─── Prerequisites ────────────────────────────────────────────────────────────
# Debian/Ubuntu ships Node.js as "nodejs"; other distros use "node".
if command -v node >/dev/null 2>&1; then
  NODE=node
elif command -v nodejs >/dev/null 2>&1; then
  NODE=nodejs
else
  err "ERROR: Node.js not found. Install it (e.g. 'sudo apt install nodejs') and re-run."
  exit 1
fi
require npm

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
VERSION=$($NODE -p "require('${SCRIPT_DIR}/package.json').version")
DATE=$(date +%Y%m%d)
GIT_HASH=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
ARCHIVE_NAME="circular-planner-airgap-${VERSION}-${DATE}"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

PLATFORM_FLAG=""
if [ -n "$PLATFORM" ]; then
  PLATFORM_FLAG="--platform $PLATFORM"
fi

echo ""
echo "============================================"
echo "   Circular Planner — Air-Gap Packager"
echo "============================================"
echo ""
echo "  Version:  ${VERSION}"
echo "  Commit:   ${GIT_HASH}"
echo "  Platform: ${PLATFORM:-$(uname -m) (host default)}"
echo ""

# ─── Step 1: Build application ────────────────────────────────────────────────
info "[1/7] Installing dependencies and building application..."
cd "$SCRIPT_DIR"
npm ci --ignore-scripts=false
npm run build

# ─── Step 2: Production node_modules ──────────────────────────────────────────
info "[2/7] Building production-only node_modules..."
PROD_DIR="$(mktemp -d)"
cp "$SCRIPT_DIR/package.json" "$PROD_DIR/"
cp "$SCRIPT_DIR/package-lock.json" "$PROD_DIR/"
(cd "$PROD_DIR" && npm ci --omit=dev)

# ─── Step 3: Stage bare-metal artifacts ───────────────────────────────────────
info "[3/7] Staging bare-metal artifacts..."
mkdir -p "$STAGING/$ARCHIVE_NAME/bare-metal"
cp -r "$PROD_DIR/node_modules" "$STAGING/$ARCHIVE_NAME/bare-metal/"
cp -r "$SCRIPT_DIR/dist"       "$STAGING/$ARCHIVE_NAME/bare-metal/"
cp -r "$SCRIPT_DIR/public"     "$STAGING/$ARCHIVE_NAME/bare-metal/"
cp    "$SCRIPT_DIR/package.json" "$STAGING/$ARCHIVE_NAME/bare-metal/"
rm -rf "$PROD_DIR"

# ─── Step 3b: Bundle .deb packages for offline bare-metal prereqs ─────────────
# This runs only on Debian/Ubuntu packaging hosts. The downloaded .debs let the
# target installer offer 'sudo dpkg -i' for nodejs + postgresql-client without
# any network access. Target distro codename must match the packaging host's.
if command -v apt-get >/dev/null 2>&1; then
  info "[4/7] Downloading .deb packages for bare-metal fallback (nodejs, postgresql-client)..."
  DEBS_DIR="$STAGING/$ARCHIVE_NAME/debs"
  mkdir -p "$DEBS_DIR/partial"
  apt-get \
    -o Dir::Cache::archives="$DEBS_DIR" \
    -o Debug::NoLocking=1 \
    --download-only --reinstall --yes \
    install nodejs postgresql-client 2>&1 | grep -v "^Get:" || true
  rm -rf "$DEBS_DIR/partial" "$DEBS_DIR/lock"
  DEB_COUNT=$(find "$DEBS_DIR" -maxdepth 1 -name '*.deb' | wc -l)
  info "  Downloaded ${DEB_COUNT} .deb file(s) to debs/"
else
  info "[4/7] Not an apt-based host — skipping .deb bundle (Docker path still works)."
fi

# ─── Step 4: Docker images ────────────────────────────────────────────────────
if [ "$SKIP_DOCKER" = false ]; then
  info "[5/7] Building and saving Docker images..."
  mkdir -p "$STAGING/$ARCHIVE_NAME/images"

  # Pull base images
  docker pull $PLATFORM_FLAG node:20.18-alpine
  docker pull $PLATFORM_FLAG postgres:16-alpine

  # Build app image
  docker build $PLATFORM_FLAG -t circular-planner:latest "$SCRIPT_DIR"

  # Save images
  info "  Saving node:20.18-alpine..."
  docker save node:20.18-alpine -o "$STAGING/$ARCHIVE_NAME/images/node-20.18-alpine.tar"
  info "  Saving postgres:16-alpine..."
  docker save postgres:16-alpine -o "$STAGING/$ARCHIVE_NAME/images/postgres-16-alpine.tar"
  info "  Saving circular-planner:latest..."
  docker save circular-planner:latest -o "$STAGING/$ARCHIVE_NAME/images/circular-planner-app.tar"

  # Generate docker-compose.airgap.yml
  sed 's/^    build: \.$/    image: circular-planner:latest/' \
    "$SCRIPT_DIR/docker-compose.yml" \
    > "$STAGING/$ARCHIVE_NAME/docker-compose.airgap.yml"
else
  info "[5/7] Skipping Docker images (--skip-docker)"
fi

# ─── Step 6: Copy installer and build info ────────────────────────────────────
info "[6/7] Writing build info and installer..."

cp "$SCRIPT_DIR/install-airgap.sh" "$STAGING/$ARCHIVE_NAME/"
chmod +x "$STAGING/$ARCHIVE_NAME/install-airgap.sh"

# Capture distro codename so the target installer can warn on mismatch.
DISTRO_CODENAME="unknown"
if [ -f /etc/os-release ]; then
  DISTRO_CODENAME=$(. /etc/os-release && echo "${VERSION_CODENAME:-${ID:-unknown}}")
fi

cat > "$STAGING/$ARCHIVE_NAME/BUILD_INFO" <<EOF
Circular Planner — Air-Gapped Deployment Package
=================================================
Version:      ${VERSION}
Git commit:   ${GIT_HASH}
Packaged:     $(date -u +%Y-%m-%dT%H:%M:%SZ)
Node.js:      $($NODE -v)
npm:          $(npm -v)
Platform:     $(uname -s) $(uname -m)
Distro:       $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}" || echo "unknown")
Codename:     ${DISTRO_CODENAME}
Docker:       $(docker --version 2>/dev/null || echo "n/a")

Contents:
  bare-metal/     Pre-built server, frontend, and production dependencies
  debs/           Offline .deb packages for nodejs + postgresql-client (apt hosts only)
  images/         Docker images (node, postgres, app) as tar archives
  install-airgap.sh  Interactive installer for the target machine

Note: For bare-metal deployment, the target machine must match
the build platform ($(uname -s) $(uname -m)). The bundled .deb packages
in debs/ are for ${DISTRO_CODENAME} — install on a different distro/codename
at your own risk. Docker images are for $([ -n "$PLATFORM" ] && echo "$PLATFORM" || echo "$(uname -m)").
EOF

# ─── Step 6: Create archive ──────────────────────────────────────────────────
info "[6/7] Creating archive..."
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
