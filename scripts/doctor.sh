#!/usr/bin/env bash
# Diagnose the workspace's connection to OpenClaw. If a server URL is given (or
# SMOKE_URL is set), query its /api/doctor; otherwise run an in-process check.
#
# Usage:  scripts/doctor.sh [http://127.0.0.1:8800]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:-${SMOKE_URL:-}}"

render() {  # reads JSON {ok, checks:[{id,ok,detail,hint}]} on stdin
  python3 -c '
import json,sys
d=json.load(sys.stdin)
for c in d["checks"]:
    mark="\033[32mok\033[0m  " if c["ok"] else "\033[31mFAIL\033[0m"
    cid=c.get("id","")
    det=c.get("detail","")
    print("  " + mark + " " + cid + ": " + det)
    if not c["ok"] and c.get("hint"):
        print("        \xe2\x86\xb3 " + c["hint"])
sys.exit(0 if d["ok"] else 1)'
}

echo "OpenClaw Workspace — connection doctor"
if [[ -n "$URL" ]]; then
  curl -fsS --max-time 20 "$URL/api/doctor" | render
else
  ( cd "$ROOT" && ./.venv/bin/python -c '
import asyncio, json
from backend import doctor
print(json.dumps(doctor.summarize(asyncio.run(doctor.run_checks()))))' ) | render
fi
