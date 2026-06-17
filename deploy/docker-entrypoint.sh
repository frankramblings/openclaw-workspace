#!/usr/bin/env bash
# OpenClaw Workspace — Docker container entrypoint.
#
# 1. If WORKSPACE_AGENT_NAME is set and differs from the baked name, re-runs
#    the frontend bake so the chosen name propagates through the UI.
# 2. Execs uvicorn. Inside the container 0.0.0.0 is correct; the host-side
#    localhost binding is enforced by the compose port mapping (127.0.0.1:8800).
#
# Idempotent: safe to re-run (setup.sh --yes --skip-connect is always safe).
set -euo pipefail

BAKED_NAME_FILE="/app/.data/branding.json"
PORT="${PORT:-8800}"

# Detect the currently baked agent name (from branding.json if present).
baked_name() {
  if [[ -f "$BAKED_NAME_FILE" ]]; then
    python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("agent_name") or "").strip())' \
      "$BAKED_NAME_FILE" 2>/dev/null || true
  fi
}

if [[ -n "${WORKSPACE_AGENT_NAME:-}" ]]; then
  current="$(baked_name)"
  if [[ "$current" != "$WORKSPACE_AGENT_NAME" ]]; then
    echo "[entrypoint] Re-baking frontend for agent name: $WORKSPACE_AGENT_NAME"
    bash /app/scripts/setup.sh \
      --name "$WORKSPACE_AGENT_NAME" \
      --yes \
      --skip-connect
  fi
fi

exec uvicorn backend.app:app --host 0.0.0.0 --port "$PORT"
