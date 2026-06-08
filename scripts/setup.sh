#!/usr/bin/env bash
# OpenClaw Workspace — first-run setup.
#
# Names your agent (the maintainer's is "Gary") and bakes that name through the
# whole UI, then prepares the frontend. Safe to re-run any time to rename.
#
# Usage:
#   scripts/setup.sh                 # interactive
#   scripts/setup.sh --name Gary     # non-interactive name
#   scripts/setup.sh --name Gary --accent '#4fe3d1' --yes
#
# Flags:
#   --name <NAME>           agent display name (skips the prompt)
#   --accent <#hex>         theme accent color   (default keeps current/ #4fe3d1)
#   --yes, -y               accept defaults, no prompts (CI / scripted installs)
#   --no-sync               skip the frontend sync step
#   --gateway-ws <url>      gateway WebSocket URL (e.g. ws://127.0.0.1:18789)
#   --enable <csv>          comma-separated integrations to enable (e.g. email,inbox)
#   --skip-connect          skip the gateway connection + doctor step
#   -h, --help              this help
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/.data"
BRANDING="$DATA_DIR/branding.json"

NAME=""
ACCENT=""
ASSUME_YES=0
DO_SYNC=1
GATEWAY_WS=""
ENABLE=""
SKIP_CONNECT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)         NAME="${2:-}"; shift 2 ;;
    --accent)       ACCENT="${2:-}"; shift 2 ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    --no-sync)      DO_SYNC=0; shift ;;
    --gateway-ws)   GATEWAY_WS="${2:-}"; shift 2 ;;
    --enable)       ENABLE="${2:-}"; shift 2 ;;
    --skip-connect) SKIP_CONNECT=1; shift ;;
    -h|--help)      awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 1 ;;
  esac
done

# Current values (re-run friendly).
read_json() { python3 -c 'import json,sys
try:
    print((json.load(open(sys.argv[1])).get(sys.argv[2]) or ""))
except Exception:
    print("")' "$BRANDING" "$1" 2>/dev/null || true; }

CUR_NAME="$(read_json agent_name)"
CUR_ACCENT="$(read_json accent)"
DEF_NAME="${CUR_NAME:-Claw}"
DEF_ACCENT="${CUR_ACCENT:-#4fe3d1}"

echo "── OpenClaw Workspace setup ─────────────────────────────"
echo

# --- Agent name -------------------------------------------------------------
if [[ -z "$NAME" ]]; then
  if [[ "$ASSUME_YES" == 1 ]]; then
    NAME="$DEF_NAME"
  else
    echo "What should your agent be called? This name appears in the title bar,"
    echo "chat header, message placeholder, app icon name — everywhere."
    printf "  Agent name [%s]: " "$DEF_NAME"
    read -r NAME || true
    NAME="${NAME:-$DEF_NAME}"
  fi
fi

# --- Accent (optional) ------------------------------------------------------
if [[ -z "$ACCENT" ]]; then
  if [[ "$ASSUME_YES" == 1 ]]; then
    ACCENT="$DEF_ACCENT"
  else
    printf "  Theme accent color (hex) [%s]: " "$DEF_ACCENT"
    read -r ACCENT || true
    ACCENT="${ACCENT:-$DEF_ACCENT}"
  fi
fi

# --- Persist ----------------------------------------------------------------
mkdir -p "$DATA_DIR"
python3 -c 'import json,sys
path, name, accent = sys.argv[1:4]
try:
    data = json.load(open(path))
except Exception:
    data = {}
data["agent_name"] = name.strip() or "Claw"
data["accent"] = accent.strip() or "#4fe3d1"
json.dump(data, open(path, "w"), indent=2)
open(path, "a").write("\n")
print("  saved %s: agent_name=%r accent=%r" % (path, data["agent_name"], data["accent"]))' \
  "$BRANDING" "$NAME" "$ACCENT"
echo

# --- Gateway connection + doctor --------------------------------------------
if [[ "$SKIP_CONNECT" != 1 ]]; then
  OPENCLAW_CFG="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
  if [[ -f "$OPENCLAW_CFG" && -z "$GATEWAY_WS" ]]; then
    echo "  Using same-host OpenClaw config ($OPENCLAW_CFG) — no URL needed."
  else
    if [[ -z "$GATEWAY_WS" && "$ASSUME_YES" != 1 ]]; then
      echo "  No same-host OpenClaw config found. Enter the gateway URL for a"
      echo "  REMOTE OpenClaw, or leave blank to use the default (ws://127.0.0.1:18789)."
      printf "  Gateway WebSocket URL [blank = default]: "
      read -r GATEWAY_WS || true
      # blank → leave empty: config.py falls back to ws://127.0.0.1:<port>; we
      # don't force-write it so a later same-host install keeps working.
    fi
  fi

  # Write connection.json only when we have something to persist.
  if [[ -n "$GATEWAY_WS" || -n "$ENABLE" ]]; then
    CONN="$DATA_DIR/connection.json"
    python3 - "$CONN" "$GATEWAY_WS" "$ENABLE" <<'PY'
import json, sys
path, gw, enable = sys.argv[1:4]
try:
    data = json.load(open(path))
except Exception:
    data = {}
if gw.strip():
    data["gateway_ws"] = gw.strip()
ints = data.get("integrations", {})
for name in [s for s in enable.split(",") if s.strip()]:
    ints[name.strip()] = True
data["integrations"] = ints
json.dump(data, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
    echo "  connection settings saved to .data/connection.json"
  fi

  echo "  verifying connection…"
  bash "$ROOT/scripts/doctor.sh" || echo "  (doctor reported issues — fix and re-run scripts/doctor.sh)"
  echo
fi

# --- Frontend sync (bakes the name into the UI) -----------------------------
if [[ "$DO_SYNC" == 1 ]]; then
  echo "Baking '$NAME' into the frontend…"
  WORKSPACE_AGENT_NAME="$NAME" bash "$ROOT/scripts/sync-frontend.sh"
  echo
fi

# --- Prereq hints + next steps ----------------------------------------------
GW_CONFIG="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
echo "── Done. Next steps ─────────────────────────────────────"
if [[ ! -f "$GW_CONFIG" ]]; then
  echo "  ⚠ OpenClaw config not found at $GW_CONFIG — install/run OpenClaw first"
  echo "    (the gateway is the brain; the workspace needs it on :18789)."
fi
cat <<EOF
  1. Create the venv + install deps (one time):
       python3 -m venv .venv && . .venv/bin/activate
       pip install -r backend/requirements.txt
  2. Run it:
       uvicorn backend.app:app --port 8800            # local
       uvicorn backend.app:app --host 0.0.0.0 --port 8800   # on your LAN/tailnet
     …then open http://127.0.0.1:8800
  3. Run on boot (macOS): scripts/install-launchagent.sh   (optional)

  Rename your agent any time:  scripts/setup.sh --name <NewName>
  Optional inbox tuning (env): INBOX_INTERNAL_DOMAIN, SLACK_DOMAIN — see .env.example
EOF
