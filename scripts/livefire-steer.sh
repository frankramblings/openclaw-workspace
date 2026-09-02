#!/usr/bin/env bash
# Live-fire for real steering. Starts a turn that runs a slow command, steers a
# number into it mid-turn, and prints whether the SAME turn's reply used it.
# Usage: scripts/livefire-steer.sh <session_id>   (a claude-cli chat's id from the sidebar URL / .data/sessions.json)
set -euo pipefail
SID="${1:?session id}"
HOST="${WORKSPACE_HOST:-http://127.0.0.1:8800}"
OUT="$(mktemp)"
curl -sN -X POST "$HOST/api/chat_stream" \
  -F "message=Run the shell command \`sleep 25\` and only after it finishes reply in ONE line: NUMBER=<n> if I told you a number by then, otherwise NUMBER=NONE. Run nothing else." \
  -F "session=$SID" -F "mode=agent" > "$OUT" &
READER=$!
sleep 8
echo "-- steering --"
curl -s -X POST "$HOST/api/chat/steer/$SID" -F "message=The number is 42." -F "client_id=livefire-1"; echo
wait "$READER" || true
echo "-- frames of interest --"
grep -E '"type": ?"user_steer"|NUMBER=' "$OUT" | head -5 || true
if grep -q 'NUMBER=42' "$OUT"; then echo "PASS: steer landed inside the running turn"; else echo "FAIL: reply did not use the steer (see $OUT)"; exit 1; fi
