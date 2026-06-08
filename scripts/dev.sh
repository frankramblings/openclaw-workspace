#!/usr/bin/env bash
# One-command local bring-up: venv + deps + frontend build + run.
# Assumes scripts/setup.sh has been run once (to name your agent). If not, it
# falls back to the default name so the app still starts.
#
# Usage:
#   scripts/dev.sh                 # 127.0.0.1:8800, --reload
#   scripts/dev.sh --port 9000
#   scripts/dev.sh --host 0.0.0.0  # (only behind a trusted network!)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="127.0.0.1"; PORT="8800"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

# venv
if [[ ! -x .venv/bin/python ]]; then
  echo "creating .venv…"; python3 -m venv .venv
fi
# deps (cheap no-op once installed)
./.venv/bin/python -m pip install -q -r backend/requirements.txt

# frontend build if missing
if [[ ! -f frontend/index.html ]]; then
  echo "frontend/ not built — running sync…"; scripts/sync-frontend.sh
fi

echo "→ http://$HOST:$PORT"
exec ./.venv/bin/python -m uvicorn backend.app:app --reload --host "$HOST" --port "$PORT"
