#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# backup.sh — dump Circular Planner's PostgreSQL database
#
# Usage:
#   BACKUP_DIR=/backups ./scripts/backup.sh
#
# Env vars:
#   DATABASE_URL            Full Postgres connection string (preferred)
#   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE  (fallback)
#   BACKUP_DIR              Directory to write dump files  (default: ./data/backups)
#   BACKUP_RETENTION_DAYS   Delete dumps older than N days (default: 14)
# ---------------------------------------------------------------------------

BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u '+%Y%m%d-%H%M%S')"
DUMP_FILE="$BACKUP_DIR/planner-${TIMESTAMP}.dump"

# ---------------------------------------------------------------------------
# Build pg_dump connection arguments
# ---------------------------------------------------------------------------
PG_ARGS=()

if [[ -n "${DATABASE_URL:-}" ]]; then
  PG_ARGS+=( "$DATABASE_URL" )
else
  [[ -n "${PGHOST:-}"     ]] && PG_ARGS+=( -h "$PGHOST" )
  [[ -n "${PGPORT:-}"     ]] && PG_ARGS+=( -p "$PGPORT" )
  [[ -n "${PGUSER:-}"     ]] && PG_ARGS+=( -U "$PGUSER" )
  [[ -n "${PGDATABASE:-}" ]] && PG_ARGS+=( "$PGDATABASE" )
fi

# ---------------------------------------------------------------------------
# Dump
# ---------------------------------------------------------------------------
echo "[backup] Writing $DUMP_FILE …"
pg_dump --format=custom --no-owner --no-privileges "${PG_ARGS[@]}" \
  --file="$DUMP_FILE"

# Verify the dump is readable
echo "[backup] Verifying dump …"
pg_restore --list "$DUMP_FILE" > /dev/null

SIZE="$(du -h "$DUMP_FILE" | awk '{print $1}')"
echo "[backup] OK — $SIZE written to $DUMP_FILE"

# ---------------------------------------------------------------------------
# Prune old dumps
# ---------------------------------------------------------------------------
echo "[backup] Pruning dumps older than ${BACKUP_RETENTION_DAYS} days …"
find "$BACKUP_DIR" -maxdepth 1 -name 'planner-*.dump' \
  -mtime +"$BACKUP_RETENTION_DAYS" -print -delete

echo "[backup] Done."
