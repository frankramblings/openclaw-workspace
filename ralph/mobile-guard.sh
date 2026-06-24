#!/usr/bin/env bash
# Regression guard for the mobile redesign. Unlike a console-error-only check,
# this verifies (1) HTTP 200, (2) the SPA shell actually rendered (.m-app/.oc-app
# present in the post-load DOM), (3) no server error page, (4) no JS console
# errors. Catches the blind spot where a transient 502 made a console-only guard
# falsely report "clean".
set -u
BASE="https://naboo.bicolor-triceratops.ts.net:8443/static/index-redesign.html"
SURFACES="${*:-chat inbox email more calendar notes settings research library}"
PROF=/home/frank/ralph-shots/pg
fail=0
for s in $SURFACES; do
  code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 12 "$BASE#$s")
  if [ "$code" != "200" ]; then echo "❌ $s: HTTP $code"; fail=1; continue; fi
  rm -rf "$PROF"
  dom=$(chromium --headless --no-sandbox --ignore-certificate-errors --user-data-dir="$PROF" \
        --virtual-time-budget=10000 --enable-logging=stderr --v=0 --dump-dom "$BASE#$s" 2>"/home/frank/ralph-shots/g-$s.log")
  err=$(grep -iE "INFO:CONSOLE.*(error|uncaught|TypeError|ReferenceError|Cannot read|is not)" "/home/frank/ralph-shots/g-$s.log" | head -1)
  if echo "$dom" | grep -qiE "isn.t working|ERROR 50[0-9]|unable to handle"; then echo "❌ $s: server error page"; fail=1; continue; fi
  if ! echo "$dom" | grep -qE 'class="m-app"|class="oc-app"'; then echo "❌ $s: app shell not rendered"; fail=1; continue; fi
  if [ -n "$err" ]; then echo "❌ $s: console: $err"; fail=1; continue; fi
  echo "✅ $s"
done
[ $fail -eq 0 ] && echo "ALL CLEAN" || echo "ISSUES FOUND"
exit $fail
