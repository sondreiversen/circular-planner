#!/usr/bin/env bash
# Circular Planner — restore script (Go backend)
# Usage: ./scripts/restore.sh --yes /path/to/planner-20260101-020000.{sqlite,dump}
#
# IMPORTANT: Stop the Go binary before restoring a SQLite database.
#   The script cannot auto-stop a running process safely. Do it yourself:
#     sudo systemctl stop circular-planner   # or
#     docker compose stop app
set -euo pipefail

# ─── Load .env if present ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck source=/dev/null
  set -a; source "$ENV_FILE"; set +a
fi

# ─── Parse arguments ─────────────────────────────────────────────────────────
YES=false
DUMP_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)  DUMP_PATH="$1"; shift ;;
  esac
done

if [ "$YES" != "true" ]; then
  echo "ERROR: --yes flag is required to confirm the destructive restore." >&2
  echo "Usage: $0 --yes <dump-path>" >&2
  exit 1
fi

if [ -z "$DUMP_PATH" ]; then
  echo "ERROR: No dump path provided." >&2
  echo "Usage: $0 --yes <dump-path>" >&2
  exit 1
fi

if [ ! -f "$DUMP_PATH" ]; then
  echo "ERROR: Dump file not found: $DUMP_PATH" >&2
  exit 1
fi

# ─── Configuration ───────────────────────────────────────────────────────────
DATABASE_URL="${DATABASE_URL:-sqlite:./data/planner.db}"
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# ─── Determine backend ────────────────────────────────────────────────────────
case "$DATABASE_URL" in
  sqlite:*)
    SQLITE_PATH="${DATABASE_URL#sqlite:}"

    # Safety dump before overwriting
    SAFETY_DUMP="$BACKUP_DIR/pre-restore-${TIMESTAMP}.sqlite"
    if [ -f "$SQLITE_PATH" ]; then
      echo "Creating safety dump at: $SAFETY_DUMP"
      if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$SQLITE_PATH" ".backup '${SAFETY_DUMP}'"
      else
        cp "$SQLITE_PATH" "$SAFETY_DUMP"
        [ -f "${SQLITE_PATH}-wal" ] && cp "${SQLITE_PATH}-wal" "${SAFETY_DUMP}-wal" || true
        [ -f "${SQLITE_PATH}-shm" ] && cp "${SQLITE_PATH}-shm" "${SAFETY_DUMP}-shm" || true
        echo "WARN: sqlite3 CLI not found; safety dump used cp fallback." >&2
      fi
    else
      echo "No existing database found at ${SQLITE_PATH}; skipping safety dump."
      SAFETY_DUMP="(none — no existing database)"
    fi

    echo ""
    echo "IMPORTANT: Ensure the Go binary is stopped before continuing."
    echo "  sudo systemctl stop circular-planner   (systemd)"
    echo "  docker compose stop app                (Docker)"
    echo ""
    read -r -p "Confirm the service is stopped and you want to restore [y/N]: " CONFIRM
    case "$CONFIRM" in
      y|Y|yes|YES) ;;
      *) echo "Restore aborted."; exit 1 ;;
    esac

    # Restore: copy dump file over active DB
    DB_DIR="$(dirname "$SQLITE_PATH")"
    mkdir -p "$DB_DIR"
    cp "$DUMP_PATH" "$SQLITE_PATH"

    # Remove stale WAL and shared-memory files so SQLite starts clean
    rm -f "${SQLITE_PATH}-wal" "${SQLITE_PATH}-shm"

    echo ""
    echo "Restore complete."
    echo "  Restored from:  $DUMP_PATH"
    echo "  Safety dump at: $SAFETY_DUMP"
    echo ""
    echo "You may now restart the service:"
    echo "  sudo systemctl start circular-planner"
    echo "  docker compose start app"
    ;;

  postgres://*|postgresql://*)
    if ! command -v pg_restore >/dev/null 2>&1; then
      echo "ERROR: pg_restore not found. Install postgresql-client." >&2
      exit 1
    fi
    if ! command -v pg_dump >/dev/null 2>&1; then
      echo "ERROR: pg_dump not found. Install postgresql-client." >&2
      exit 1
    fi

    # Safety dump
    SAFETY_DUMP="$BACKUP_DIR/pre-restore-${TIMESTAMP}.dump"
    echo "Creating safety dump at: $SAFETY_DUMP"
    pg_dump \
      --format=custom \
      --no-owner \
      --no-privileges \
      --file="$SAFETY_DUMP" \
      "$DATABASE_URL"

    echo "Restoring from $DUMP_PATH ..."
    pg_restore \
      --clean \
      --if-exists \
      --no-owner \
      --no-privileges \
      --dbname="$DATABASE_URL" \
      "$DUMP_PATH"

    echo ""
    echo "Restore complete."
    echo "  Restored from:  $DUMP_PATH"
    echo "  Safety dump at: $SAFETY_DUMP"
    ;;

  *)
    echo "ERROR: Unrecognised DATABASE_URL scheme: ${DATABASE_URL}" >&2
    exit 1
    ;;
esac
