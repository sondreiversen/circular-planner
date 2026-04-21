#!/usr/bin/env bash
# Circular Planner — backup script (Go backend)
# Supports SQLite (default) and Postgres.
# Usage: BACKUP_DIR=/var/backups/planner ./scripts/backup.sh
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
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# ─── Determine backend ────────────────────────────────────────────────────────
case "$DATABASE_URL" in
  sqlite:*)
    # ── SQLite backup ────────────────────────────────────────────────────────
    SQLITE_PATH="${DATABASE_URL#sqlite:}"
    DST="$BACKUP_DIR/planner-${TIMESTAMP}.sqlite"

    if [ ! -f "$SQLITE_PATH" ]; then
      echo "ERROR: SQLite database not found at ${SQLITE_PATH}" >&2
      exit 1
    fi

    if command -v sqlite3 >/dev/null 2>&1; then
      # Preferred: sqlite3 .backup creates a clean, consistent copy of the DB
      # even if a WAL transaction is in progress. No WAL tail is left behind.
      sqlite3 "$SQLITE_PATH" ".backup '${DST}'"
    else
      # Fallback: raw file copy. If the DB is open and in WAL mode the copy
      # may include an incomplete WAL tail. The Go binary can replay it on
      # startup via `./planner migrate status`, but treat the copy as slightly
      # inconsistent until confirmed healthy.
      cp "$SQLITE_PATH" "$DST"
      # Copy WAL and shared-memory files if they exist (needed for consistency)
      [ -f "${SQLITE_PATH}-wal" ] && cp "${SQLITE_PATH}-wal" "${DST}-wal" || true
      [ -f "${SQLITE_PATH}-shm" ] && cp "${SQLITE_PATH}-shm" "${DST}-shm" || true
      echo "WARN: sqlite3 CLI not found; used cp fallback. Verify with: ./planner migrate status" >&2
    fi

    # Prune old backups (only .sqlite files, leave -wal/-shm files beside their parent)
    find "$BACKUP_DIR" -maxdepth 1 -name "planner-*.sqlite" \
      -mtime "+${BACKUP_RETENTION_DAYS}" -delete 2>/dev/null || true

    echo "Backup written to: $DST"
    ;;

  postgres://*|postgresql://*)
    # ── Postgres backup ──────────────────────────────────────────────────────
    if ! command -v pg_dump >/dev/null 2>&1; then
      echo "ERROR: pg_dump not found. Install postgresql-client." >&2
      exit 1
    fi
    if ! command -v pg_restore >/dev/null 2>&1; then
      echo "ERROR: pg_restore not found. Install postgresql-client." >&2
      exit 1
    fi

    DST="$BACKUP_DIR/planner-${TIMESTAMP}.dump"

    pg_dump \
      --format=custom \
      --no-owner \
      --no-privileges \
      --file="$DST" \
      "$DATABASE_URL"

    # Verify the dump is readable
    if ! pg_restore --list "$DST" >/dev/null; then
      echo "ERROR: pg_restore --list failed; dump may be corrupt: $DST" >&2
      exit 1
    fi

    # Prune old backups
    find "$BACKUP_DIR" -maxdepth 1 -name "planner-*.dump" \
      -mtime "+${BACKUP_RETENTION_DAYS}" -delete 2>/dev/null || true

    echo "Backup written to: $DST"
    ;;

  *)
    echo "ERROR: Unrecognised DATABASE_URL scheme: ${DATABASE_URL}" >&2
    echo "Expected sqlite:<path> or postgres[ql]://<...>" >&2
    exit 1
    ;;
esac
