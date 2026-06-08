#!/usr/bin/env bash
# Self-check that an install is wired correctly. Static checks always run; if you
# pass a base URL (or set SMOKE_URL), it also probes the live HTTP endpoints.
#
# Usage:
#   scripts/smoke.sh                         # static checks only
#   scripts/smoke.sh http://127.0.0.1:8800   # + live endpoint probes
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:-${SMOKE_URL:-}}"
fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

echo "OpenClaw Workspace — smoke test"
echo "── static ──────────────────────────────────────────────"

# Branding configured
if [[ -f "$ROOT/.data/branding.json" ]]; then
  name="$(python3 -c 'import json;print(json.load(open("'"$ROOT"'/.data/branding.json")).get("agent_name",""))' 2>/dev/null)"
  [[ -n "$name" ]] && ok "agent name set: $name" || bad "branding.json has no agent_name (run scripts/setup.sh)"
else
  bad "no .data/branding.json (run scripts/setup.sh)"
fi

# Frontend built
if [[ -f "$ROOT/frontend/index.html" ]]; then
  ok "frontend/ built ($(find "$ROOT/frontend" -type f | wc -l | tr -d ' ') files)"
else
  bad "frontend/ not built (run scripts/setup.sh or scripts/sync-frontend.sh)"
fi

# No un-baked tokens leaked into the build
if [[ -d "$ROOT/frontend" ]]; then
  n="$(grep -rl '__AGENT_NAME__' "$ROOT/frontend" 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$n" == 0 ]] && ok "no un-baked __AGENT_NAME__ tokens" || bad "$n files still contain __AGENT_NAME__ (re-run sync)"
fi

# Backend imports
if python3 -c "import sys; sys.path.insert(0,'$ROOT'); import backend.config" 2>/dev/null; then
  ok "backend imports"
else
  bad "backend.config failed to import"
fi

# Gateway config present (the brain)
GW="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
[[ -f "$GW" ]] && ok "OpenClaw config found ($GW)" || bad "no OpenClaw config at $GW — the gateway is the brain"
echo "  (run scripts/doctor.sh to verify the live gateway connection)"

# Live probes (optional)
if [[ -n "$URL" ]]; then
  echo "── live ($URL) ─────────────────────────────────────────"
  cfg="$(curl -fsS --max-time 5 "$URL/api/config" 2>/dev/null || true)"
  if echo "$cfg" | grep -q '"agent_name"'; then
    ok "/api/config → $(echo "$cfg" | python3 -c 'import json,sys;print(json.load(sys.stdin)["agent_name"])' 2>/dev/null)"
  else
    bad "/api/config not responding"
  fi
  h="$(curl -fsS --max-time 5 "$URL/api/health" 2>/dev/null || true)"
  echo "$h" | grep -q '"ok"' && ok "/api/health ok (has_password=$(echo "$h" | grep -o '"has_password":[a-z]*' | cut -d: -f2))" || bad "/api/health not responding"
fi

echo "────────────────────────────────────────────────────────"
[[ "$fail" == 0 ]] && { echo "all checks passed"; exit 0; } || { echo "some checks FAILED"; exit 1; }
