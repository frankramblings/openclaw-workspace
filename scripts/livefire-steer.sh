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
    # "your own Bash tool" is load-bearing: Gary's default shell route is a curl
    # to the workspace terminal on :8800, whose capability token belongs to the
    # instance that minted it. From a dev instance on another port that curl
    # returns {"detail":"forbidden"}, the sleep never runs, and the turn ends
    # before the steer lands -- a FAIL that says nothing about steering.
    # Hand over the EXACT command. A bare `sleep 25` is blocked by Claude Code's
    # own harness ("use Monitor with an until-loop"); when that happens the turn
    # gives up in ~7s and answers before the steer is even sent, which reads as a
    # steering FAIL but measures nothing. The until-loop below is permitted and
    # reliably holds the turn open for ~25s.
    PROMPT='Using YOUR OWN Bash tool (NOT the terminal curl), run EXACTLY this one command: `end=$(( $(date +%s) + 25 )); until [ $(date +%s) -ge $end ]; do sleep 2; done; echo waited`. Only after it finishes, reply in ONE line: NUMBER=<n> if I told you a number by then, otherwise NUMBER=NONE. Run nothing else.'
    STEER_AT=8
    ;;
  prose)
    # 1..400, not 1..40: a current model streams forty numbers in ~2s, so the
    # steer landed after turn_end and the route answered no_active_turn -- a
    # FAIL that measured nothing. "Slowly" is not honoured; length is.
    PROMPT='Count from 1 to 400, one number per line, no tools, no commentary. If I tell you a number while you are counting, stop counting immediately and reply in ONE line: NUMBER=<n>.'
    STEER_AT=6
    ;;
  *)
    echo "unknown SCENARIO=$SCENARIO (want: tool | prose)" >&2; exit 2 ;;
esac

echo "-- scenario: $SCENARIO (steer at ${STEER_AT}s) --"
# --form-string, NOT -F: curl parses `;` in an -F value as the start of a
# parameter (";type=", ";filename="), so the prompt was delivered truncated at
# its first semicolon and the turn never ran the command at all (2026-09-10).
curl -sN -X POST "$HOST/api/chat_stream" \
  --form-string "message=$PROMPT" \
  --form-string "session=$SID" --form-string "mode=agent" > "$OUT" &
READER=$!
sleep "$STEER_AT"
echo "-- steering --"
curl -s -X POST "$HOST/api/chat/steer/$SID" --form-string "message=The number is 42." --form-string "client_id=livefire-1"; echo
wait "$READER" || true
echo "-- frames of interest --"
grep -E '"type": ?"user_steer"|NUMBER=' "$OUT" | head -5 || true

# The reply arrives as SSE deltas, so the answer is routinely split across
# frames ("NUMBER=" then "42"). Reconstruct the assistant text before matching:
# grepping raw lines reports a landed steer as a FAIL (seen 2026-09-10).
ANSWER="$(python3 - "$OUT" <<'PY'
import json, sys
parts = []
for line in open(sys.argv[1]):
    if not line.startswith("data: "):
        continue
    body = line[6:].strip()
    if body == "[DONE]":
        continue
    try:
        frame = json.loads(body)
    except ValueError:
        continue
    if isinstance(frame, dict) and isinstance(frame.get("delta"), str):
        parts.append(frame["delta"])
print("".join(parts))
PY
)"
echo "-- reconstructed reply: ${ANSWER//$'\n'/ } --"

if [ "$SCENARIO" = "prose" ]; then
  # PASS needs BOTH halves: the steer frame was recorded into the turn, AND the
  # text that followed it acknowledged the number. Either half alone means the
  # message was accepted but never read (the honesty-rescue case in the client).
  if grep -qE '"type": ?"user_steer"' "$OUT" && [[ "$ANSWER" == *NUMBER=42* ]]; then
    echo "PASS: prose steer was read inside the running turn"
  else
    echo "FAIL: prose steer was not answered in this turn (see $OUT)"; exit 1
  fi
else
  if [[ "$ANSWER" == *NUMBER=42* ]]; then
    echo "PASS: steer landed inside the running turn"
  else
    echo "FAIL: reply did not use the steer (see $OUT)"; exit 1
  fi
fi
