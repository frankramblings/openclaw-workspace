#!/usr/bin/env bash
# Live-fire for real steering. Starts a turn, steers a number into it mid-turn,
# and prints whether the SAME turn's reply used it.
#
# Two scenarios (SCENARIO env var):
#   tool  (default) - the turn is inside a long tool call when the steer lands.
#                     This is the easy case: Claude Code delivers a queued stdin
#                     message at the next tool boundary.
#   prose           - the turn is streaming prose with NO tool boundary left.
#                     This is review finding 1a: with nothing to interrupt, the
#                     steer can be read only if the CLI is still consuming stdin,
#                     so this scenario is what tells us whether the final-prose
#                     window really loses the message.
#
# Usage: SCENARIO=prose scripts/livefire-steer.sh <session_id>
#        (a claude-cli chat's id from the sidebar URL / .data/sessions.json)
set -euo pipefail
SID="${1:?session id}"
HOST="${WORKSPACE_HOST:-http://127.0.0.1:8800}"
SCENARIO="${SCENARIO:-tool}"
OUT="$(mktemp)"

case "$SCENARIO" in
  tool)
    PROMPT='Run the shell command `sleep 25` and only after it finishes reply in ONE line: NUMBER=<n> if I told you a number by then, otherwise NUMBER=NONE. Run nothing else.'
    STEER_AT=8
    ;;
  prose)
    PROMPT='Count from 1 to 40 slowly, one number per line, no tools. If I tell you a number while you are counting, stop counting and reply in ONE line: NUMBER=<n>.'
    STEER_AT=6
    ;;
  *)
    echo "unknown SCENARIO=$SCENARIO (want: tool | prose)" >&2; exit 2 ;;
esac

echo "-- scenario: $SCENARIO (steer at ${STEER_AT}s) --"
curl -sN -X POST "$HOST/api/chat_stream" \
  -F "message=$PROMPT" \
  -F "session=$SID" -F "mode=agent" > "$OUT" &
READER=$!
sleep "$STEER_AT"
echo "-- steering --"
curl -s -X POST "$HOST/api/chat/steer/$SID" -F "message=The number is 42." -F "client_id=livefire-1"; echo
wait "$READER" || true
echo "-- frames of interest --"
grep -E '"type": ?"user_steer"|NUMBER=' "$OUT" | head -5 || true

if [ "$SCENARIO" = "prose" ]; then
  # PASS needs BOTH halves: the steer frame was recorded into the turn, AND the
  # text that followed it acknowledged the number. Either half alone means the
  # message was accepted but never read (the honesty-rescue case in the client).
  if grep -qE '"type": ?"user_steer"' "$OUT" && grep -q 'NUMBER=42' "$OUT"; then
    echo "PASS: prose steer was read inside the running turn"
  else
    echo "FAIL: prose steer was not answered in this turn (see $OUT)"; exit 1
  fi
else
  if grep -q 'NUMBER=42' "$OUT"; then
    echo "PASS: steer landed inside the running turn"
  else
    echo "FAIL: reply did not use the steer (see $OUT)"; exit 1
  fi
fi
