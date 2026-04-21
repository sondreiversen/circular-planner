#!/usr/bin/env bash
# Circular Planner — preflight check (Go backend)
# Usage: ./scripts/doctor.sh
# Exit 0 if no FAIL; 1 if any FAIL.
set -euo pipefail

# ─── Load .env if present ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck source=/dev/null
  set -a; source "$ENV_FILE"; set +a
fi

# ─── Configuration ───────────────────────────────────────────────────────────
DATABASE_URL="${DATABASE_URL:-sqlite:./data/planner.db}"
INSTALL_DIR="${INSTALL_DIR:-}"

# ─── Counters ────────────────────────────────────────────────────────────────
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# ─── Output helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { printf "${GREEN}[PASS]${NC}  %-30s %s\n" "$1" "$2"; PASS_COUNT=$((PASS_COUNT + 1)); }
warn() { printf "${YELLOW}[WARN]${NC}  %-30s %s\n" "$1" "$2"; WARN_COUNT=$((WARN_COUNT + 1)); }
fail() { printf "${RED}[FAIL]${NC}  %-30s %s\n" "$1" "$2"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
skip() { printf "${CYAN}[SKIP]${NC}  %-30s %s\n" "$1" "$2"; SKIP_COUNT=$((SKIP_COUNT + 1)); }

echo ""
echo "Circular Planner — preflight check (Go backend)"
echo ""

# ─── Check 1: planner binary present and executable ──────────────────────────
PLANNER_BIN=""
if [ -x "./planner" ]; then
  PLANNER_BIN="./planner"
elif [ -n "$INSTALL_DIR" ] && [ -x "$INSTALL_DIR/planner" ]; then
  PLANNER_BIN="$INSTALL_DIR/planner"
fi

if [ -n "$PLANNER_BIN" ]; then
  pass "planner binary" "Found: ${PLANNER_BIN}"
else
  if [ -n "$INSTALL_DIR" ]; then
    warn "planner binary" "Not found in ./ or ${INSTALL_DIR}/. Build with: go build -o planner ."
  else
    warn "planner binary" "Not found in ./. Build with: go build -o planner . (or set INSTALL_DIR)"
  fi
fi

# ─── Check 2: JWT_SECRET set and >= 32 chars ─────────────────────────────────
JWT_SECRET="${JWT_SECRET:-}"
if [ -z "$JWT_SECRET" ]; then
  fail "JWT_SECRET" "Not set. Generate one with: openssl rand -hex 32"
elif [ "${#JWT_SECRET}" -lt 32 ]; then
  fail "JWT_SECRET" "Too short (${#JWT_SECRET} chars, need ≥ 32). Generate with: openssl rand -hex 32"
else
  pass "JWT_SECRET" "Set (${#JWT_SECRET} chars)"
fi

# ─── Check 3 & 4: DB reachable + pending migrations ──────────────────────────
if [ -n "$PLANNER_BIN" ]; then
  MIGRATE_OUT=""
  MIGRATE_EXIT=0
  MIGRATE_OUT=$(cd "$(dirname "$PLANNER_BIN")" && ./planner migrate status 2>&1) || MIGRATE_EXIT=$?

  if [ "$MIGRATE_EXIT" -ne 0 ]; then
    fail "DB reachable" "Cannot connect. Check DATABASE_URL. Error: $(echo "$MIGRATE_OUT" | head -1)"
    skip "Pending migrations" "Skipped (DB unreachable)"
  else
    pass "DB reachable" "Connected successfully"

    # Parse pending count from output lines that start with "pending:" or contain "pending"
    # The output format from `./planner migrate status` typically lists pending migrations
    PENDING=0
    if echo "$MIGRATE_OUT" | grep -qi "pending"; then
      # Count lines that indicate pending migrations
      PENDING=$(echo "$MIGRATE_OUT" | grep -ci "pending" || true)
    fi

    if [ "$PENDING" -gt 0 ]; then
      warn "Pending migrations" "${PENDING} pending migration(s). Run: ./planner migrate"
    else
      pass "Pending migrations" "All migrations applied"
    fi
  fi
else
  skip "DB reachable" "Skipped (planner binary not found)"
  skip "Pending migrations" "Skipped (planner binary not found)"
fi

# ─── Check 5: Free disk in DATA_DIR ──────────────────────────────────────────
DATA_DIR="${DATA_DIR:-./data}"
if [ -d "$DATA_DIR" ] || mkdir -p "$DATA_DIR" 2>/dev/null; then
  # df -BG gives "NnG" in the Available column; strip the trailing G
  FREE_GB=$(df -BG "$DATA_DIR" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}' || echo "0")
  FREE_GB="${FREE_GB:-0}"
  if [ "$FREE_GB" -lt 1 ] 2>/dev/null; then
    warn "Disk (DATA_DIR)" "< 1 GB free in ${DATA_DIR} (${FREE_GB} GB). Free up disk space."
  else
    pass "Disk (DATA_DIR)" "${FREE_GB} GB free in ${DATA_DIR}"
  fi
else
  warn "Disk (DATA_DIR)" "Cannot access ${DATA_DIR}"
fi

# ─── Check 6: Free disk in BACKUP_DIR ────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-}"
if [ -z "$BACKUP_DIR" ]; then
  skip "Disk (BACKUP_DIR)" "BACKUP_DIR not set"
else
  if [ -d "$BACKUP_DIR" ] || mkdir -p "$BACKUP_DIR" 2>/dev/null; then
    FREE_GB=$(df -BG "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}' || echo "0")
    FREE_GB="${FREE_GB:-0}"
    if [ "$FREE_GB" -lt 1 ] 2>/dev/null; then
      warn "Disk (BACKUP_DIR)" "< 1 GB free in ${BACKUP_DIR} (${FREE_GB} GB). Free up disk space."
    else
      pass "Disk (BACKUP_DIR)" "${FREE_GB} GB free in ${BACKUP_DIR}"
    fi
  else
    warn "Disk (BACKUP_DIR)" "Cannot access ${BACKUP_DIR}"
  fi
fi

# ─── Check 7: Postgres connection usage ──────────────────────────────────────
case "$DATABASE_URL" in
  postgres://*|postgresql://*)
    if ! command -v psql >/dev/null 2>&1; then
      skip "Postgres connections" "psql not found (install postgresql-client to enable this check)"
    else
      PG_OUT=""
      PG_EXIT=0
      PG_OUT=$(psql -At -c "SELECT current_setting('max_connections')::int, count(*) FROM pg_stat_activity" \
        "$DATABASE_URL" 2>&1) || PG_EXIT=$?

      if [ "$PG_EXIT" -ne 0 ]; then
        warn "Postgres connections" "Could not query pg_stat_activity: $(echo "$PG_OUT" | head -1)"
      else
        MAX_CONN=$(echo "$PG_OUT" | awk -F'|' '{print $1}')
        CURR_CONN=$(echo "$PG_OUT" | awk -F'|' '{print $2}')
        if [ -n "$MAX_CONN" ] && [ "$MAX_CONN" -gt 0 ] 2>/dev/null; then
          PCT=$(( CURR_CONN * 100 / MAX_CONN ))
          if [ "$PCT" -gt 80 ]; then
            warn "Postgres connections" "${CURR_CONN} / ${MAX_CONN} connections used (${PCT}%). Consider increasing max_connections."
          else
            pass "Postgres connections" "${CURR_CONN} / ${MAX_CONN} connections used (${PCT}%)"
          fi
        else
          warn "Postgres connections" "Could not parse connection stats from output"
        fi
      fi
    fi
    ;;
  *)
    skip "Postgres connections" "Not Postgres (DATABASE_URL is SQLite or unknown)"
    ;;
esac

# ─── Summary ──────────────────────────────────────────────────────────────────
TOTAL=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT + SKIP_COUNT))
echo ""
echo "  ${TOTAL} check(s): ${PASS_COUNT} passed, ${WARN_COUNT} warned, ${FAIL_COUNT} failed, ${SKIP_COUNT} skipped"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
