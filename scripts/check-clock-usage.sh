#!/usr/bin/env bash
#
# check-clock-usage.sh — guard the injectable clock abstraction.
#
# Date-dependent rendering reads now() from client/src/clock.ts so the disc is a
# pure function of time. That is what lets one engine drive the live display,
# the flyover, a frozen poster and the scrubber. A single stray `new Date()` in
# rendering code silently breaks determinism, and the symptom shows up far from
# the cause — a frame that renders "today" in the middle of a 1998 sweep.
#
# So: every `new Date()` in client/src/ must either live in clock.ts, or carry
# an explicit same-line marker saying why it legitimately wants the wall clock:
#
#     const wallNow = new Date(); // clock-exempt: scheduling, not rendering
#
# The marker is deliberately same-line and deliberately annoying to write. It is
# a speed bump, and the reason is written where the next reader will see it.
#
# Exits 0 when clean, 1 when an unmarked call is found.

set -euo pipefail

SRC_DIR="${1:-client/src}"
MARKER="clock-exempt"
CLOCK_IMPL="clock.ts"

if [ ! -d "$SRC_DIR" ]; then
  echo "check-clock-usage: no such directory: $SRC_DIR" >&2
  exit 1
fi

violations=0

# -n gives file:line:content. The clock implementation is exempt wholesale: it
# is the one place allowed to actually read the wall clock, and its own doc
# comments mention `new Date()` too.
while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  line="${rest%%:*}"
  content="${rest#*:}"

  case "$(basename "$file")" in
    "$CLOCK_IMPL") continue ;;
  esac

  case "$content" in
    *"$MARKER"*) continue ;;
  esac

  if [ "$violations" -eq 0 ]; then
    echo "check-clock-usage: unmarked \`new Date()\` outside $CLOCK_IMPL" >&2
    echo >&2
  fi
  echo "  $file:$line" >&2
  echo "    ${content#"${content%%[![:space:]]*}"}" >&2
  violations=$((violations + 1))
done < <(grep -rn --include='*.ts' 'new Date()' "$SRC_DIR" || true)

if [ "$violations" -gt 0 ]; then
  cat >&2 <<EOF

$violations unmarked call(s).

If this renders something date-dependent, import now() from './clock' instead:

    import { now } from './clock';
    const today = now();

If it genuinely needs the real wall clock — scheduling a timer, stamping a log
entry, naming an export file, anchoring a write — mark it and say why:

    const t = new Date(); // clock-exempt: <reason>

EOF
  exit 1
fi

echo "check-clock-usage: OK — no unmarked \`new Date()\` in $SRC_DIR"
