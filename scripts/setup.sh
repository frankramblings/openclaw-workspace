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
#   --name <NAME>       agent display name (skips the prompt)
#   --accent <#hex>     theme accent color   (default keeps current/ #4fe3d1)
#   --yes, -y           accept defaults, no prompts (CI / scripted installs)
#   --no-sync           skip the frontend sync step
#   -h, --help          this help
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/.data"
BRANDING="$DATA_DIR/branding.json"

NAME=""
ACCENT=""
ASSUME_YES=0
DO_SYNC=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)     NAME="${2:-}"; shift 2 ;;
    --accent)   ACCENT="${2:-}"; shift 2 ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --no-sync)  DO_SYNC=0; shift ;;
    -h|--help)  awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
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
