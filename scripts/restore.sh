#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# restore.sh — restore Circular Planner's PostgreSQL database from a dump
#
# Usage:
#   ./scripts/restore.sh --yes /path/to/planner-YYYYMMDD-HHMMSS.dump
#
# The script takes a pre-restore safety dump BEFORE overwriting data.
# The path to that safety dump is printed at the end.
#
# Env vars:
#   DATABASE_URL            Full Postgres connection string (preferred)
#   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE  (fallback)
#   BACKUP_DIR              Directory for the safety dump (default: ./data/backups)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
CONFIRMED=false
DUMP_FILE=""

for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRMED=true ;;
    -*)    echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)     DUMP_FILE="$arg" ;;
  esac
done

if [[ -z "$DUMP_FILE" ]]; then
  echo "Usage: $0 --yes <dump-file>" >&2
  exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Error: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

if [[ "$CONFIRMED" != "true" ]]; then
  echo "Error: pass --yes to confirm the restore (this will overwrite all data)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build connection arguments shared by pg_dump and pg_restore
# ---------------------------------------------------------------------------
PG_ARGS=()

if [[ -n "${DATABASE_URL:-}" ]]; then
  PG_ARGS+=( "$DATABASE_URL" )
else
  [[ -n "${PGHOST:-}"     ]] && PG_ARGS+=( -h "$PGHOST" )
  [[ -n "${PGPORT:-}"     ]] && PG_ARGS+=( -p "$PGPORT" )
  [[ -n "${PGUSER:-}"     ]] && PG_ARGS+=( -U "$PGUSER" )
  [[ -n "${PGDATABASE:-}" ]] && PG_ARGS+=( -d "${PGDATABASE:-circular_planner}" )
fi

# ---------------------------------------------------------------------------
# Pre-restore safety dump
# ---------------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u '+%Y%m%d-%H%M%S')"
SAFETY_DUMP="$BACKUP_DIR/pre-restore-${TIMESTAMP}.dump"

echo "[restore] Taking safety dump → $SAFETY_DUMP …"
pg_dump --format=custom --no-owner --no-privileges "${PG_ARGS[@]}" \
  --file="$SAFETY_DUMP"
echo "[restore] Safety dump OK."

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
echo "[restore] Restoring $DUMP_FILE …"
pg_restore --clean --if-exists --no-owner --no-privileges \
  "${PG_ARGS[@]}" "$DUMP_FILE"

echo "[restore] Done."
echo "[restore] Safety dump is at: $SAFETY_DUMP"
