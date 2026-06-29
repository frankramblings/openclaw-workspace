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
#
# Email setup (standalone; exits after configuration):
#   --add-email             configure a new email account (Gmail or IMAP)
#   --email-provider        gmail or imap
#   --email-address         your email address
#   --email-name            display name (defaults to --email-address)
#   --imap-host             IMAP server host (imap only)
#   --imap-port             IMAP port (default 993)
#   --smtp-host             SMTP server host (imap only)
#   --smtp-port             SMTP port (default 465)
#   EMAIL_PW=<pw>           app password (env var, not flag; prompted if omitted)
#
# Calendar setup (standalone; exits after configuration):
#   --add-calendar          configure the calendar provider
#   --calendar-provider     google or caldav
#   --caldav-url            CalDAV home URL (e.g. https://caldav.fastmail.com/dav/calendars/user/you/)
#   --caldav-username       CalDAV username
#   CALDAV_PW=<pw>          CalDAV app password (env var, not flag; prompted if omitted)
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
ADD_EMAIL=0
EMAIL_PROVIDER=""
EMAIL_ADDRESS=""
EMAIL_NAME=""
IMAP_HOST=""
IMAP_PORT="993"
SMTP_HOST=""
SMTP_PORT="465"
ADD_CAL=0
CAL_PROVIDER=""
CALDAV_URL=""
CALDAV_USER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)         NAME="${2:-}"; shift 2 ;;
    --accent)       ACCENT="${2:-}"; shift 2 ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    --no-sync)      DO_SYNC=0; shift ;;
    --gateway-ws)   GATEWAY_WS="${2:-}"; shift 2 ;;
    --enable)       ENABLE="${2:-}"; shift 2 ;;
    --skip-connect) SKIP_CONNECT=1; shift ;;
    --add-email)       ADD_EMAIL=1; shift ;;
    --email-provider)  EMAIL_PROVIDER="${2:-}"; shift 2 ;;
    --email-address)   EMAIL_ADDRESS="${2:-}"; shift 2 ;;
    --email-name)      EMAIL_NAME="${2:-}"; shift 2 ;;
    --imap-host)       IMAP_HOST="${2:-}"; shift 2 ;;
    --imap-port)       IMAP_PORT="${2:-}"; shift 2 ;;
    --smtp-host)       SMTP_HOST="${2:-}"; shift 2 ;;
    --smtp-port)       SMTP_PORT="${2:-}"; shift 2 ;;
    --add-calendar)       ADD_CAL=1; shift ;;
    --calendar-provider)  CAL_PROVIDER="${2:-}"; shift 2 ;;
    --caldav-url)         CALDAV_URL="${2:-}"; shift 2 ;;
    --caldav-username)    CALDAV_USER="${2:-}"; shift 2 ;;
    -h|--help)      awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 1 ;;
  esac
done

if [[ "$ADD_EMAIL" == 1 ]]; then
  HIMA_CFG="${HIMALAYA_CONFIG:-$HOME/.config/himalaya/config.toml}"
  SECRET_DIR="$(dirname "$HIMA_CFG")"
  # provider
  if [[ -z "$EMAIL_PROVIDER" ]]; then
    printf "  Email provider [gmail/imap]: "; read -r EMAIL_PROVIDER || true
  fi
  [[ "$EMAIL_PROVIDER" == "gmail" || "$EMAIL_PROVIDER" == "imap" ]] \
    || { echo "provider must be 'gmail' or 'imap'" >&2; exit 1; }
  if [[ -z "$EMAIL_ADDRESS" ]]; then
    printf "  Email address: "; read -r EMAIL_ADDRESS || true
  fi
  EMAIL_NAME="${EMAIL_NAME:-$EMAIL_ADDRESS}"
  if [[ "$EMAIL_PROVIDER" == "imap" ]]; then
    [[ -n "$IMAP_HOST" ]] || { printf "  IMAP host: "; read -r IMAP_HOST || true; }
    [[ -n "$SMTP_HOST" ]] || { printf "  SMTP host: "; read -r SMTP_HOST || true; }
  fi
  # password via env (not argv → not visible in ps); prompt hidden if interactive
  if [[ -z "${EMAIL_PW:-}" ]]; then
    printf "  App password (input hidden): "; read -rs EMAIL_PW || true; echo
  fi
  SECRET_PATH="$SECRET_DIR/.workspace-email-secret"
  EMAIL_PW="$EMAIL_PW" python3 - "$ROOT" "$EMAIL_PROVIDER" "$EMAIL_ADDRESS" \
      "$EMAIL_NAME" "$HIMA_CFG" "$SECRET_PATH" "$IMAP_HOST" "$IMAP_PORT" \
      "$SMTP_HOST" "$SMTP_PORT" <<'PY'
import os, sys
sys.path.insert(0, sys.argv[1])
from backend import email_config
prov, addr, name, cfg, secret, ih, ip, sh, sp = sys.argv[2:11]
out = email_config.add_account(
    provider=prov, email=addr, display_name=name, password=os.environ["EMAIL_PW"],
    config_path=cfg, secret_path=secret,
    imap_host=ih or None, imap_port=int(ip or 993),
    smtp_host=sh or None, smtp_port=int(sp or 465))
print(f"  wrote account '{out['account_id']}' (default={out['is_default']}) to {cfg}")
PY
  # enable the integration
  python3 - "$DATA_DIR/connection.json" <<'PY'
import json, sys
path = sys.argv[1]
try: data = json.load(open(path))
except Exception: data = {}
data.setdefault("integrations", {})["email"] = True
import os; os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(data, open(path, "w"), indent=2); open(path, "a").write("\n")
PY
  echo "  ✓ email enabled. Restart the workspace to pick up the new account."
  exit 0
fi

if [[ "$ADD_CAL" == 1 ]]; then
  [[ -z "$CAL_PROVIDER" ]] && { printf "  Calendar provider [google/caldav]: "; read -r CAL_PROVIDER || true; }
  [[ "$CAL_PROVIDER" == "google" || "$CAL_PROVIDER" == "caldav" ]] || { echo "provider must be google or caldav" >&2; exit 1; }
  if [[ "$CAL_PROVIDER" == "caldav" ]]; then
    [[ -n "$CALDAV_URL" ]]  || { printf "  CalDAV URL (calendar home, e.g. https://caldav.fastmail.com/dav/calendars/user/you/): "; read -r CALDAV_URL || true; }
    [[ -n "$CALDAV_USER" ]] || { printf "  CalDAV username: "; read -r CALDAV_USER || true; }
    [[ -n "$CALDAV_URL" && -n "$CALDAV_USER" ]] || { echo "CalDAV url + username required" >&2; exit 1; }
    [[ -n "${CALDAV_PW:-}" ]] || { printf "  CalDAV app password (hidden): "; read -rs CALDAV_PW || true; echo; }
  fi
  CALDAV_PW="${CALDAV_PW:-}" python3 - "$DATA_DIR" "$CAL_PROVIDER" "$CALDAV_URL" "$CALDAV_USER" <<'PY'
import json, os, sys
data_dir, prov, url, user = sys.argv[1:5]
cal = {"provider": prov}
if prov == "caldav":
    cal["caldav"] = {"url": url, "username": user}
    sdir = os.path.join(data_dir, "secrets"); os.makedirs(sdir, mode=0o700, exist_ok=True)
    sp = os.path.join(sdir, "caldav-password")
    fd = os.open(sp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try: os.write(fd, "".join(os.environ.get("CALDAV_PW","").split()).encode())
    finally: os.close(fd)
os.makedirs(data_dir, exist_ok=True)
json.dump(cal, open(os.path.join(data_dir, "calendar.json"), "w"), indent=2)
open(os.path.join(data_dir, "calendar.json"), "a").write("\n")
conn = os.path.join(data_dir, "connection.json")
try: c = json.load(open(conn))
except Exception: c = {}
c.setdefault("integrations", {})["calendar"] = True
json.dump(c, open(conn, "w"), indent=2); open(conn, "a").write("\n")
print(f"  ✓ calendar provider '{prov}' configured + enabled")
PY
  echo "  Restart the workspace to pick up the calendar."
  exit 0
fi

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

# --- App icon (initials from the name by default; helmet is the maintainer's
#     opt-in via branding.json "icon_mode": "helmet") --------------------------
# Best-effort: needs node + sharp. If unavailable we keep the committed default
# mark and print how to generate it later — setup never fails on the icon.
if [[ "$DO_SYNC" == 1 ]]; then
  ICON_DIR="$ROOT/scripts/icons"
  if command -v node >/dev/null 2>&1; then
    echo "Generating the app icon…"
    if [[ ! -d "$ICON_DIR/node_modules/sharp" ]] && command -v npm >/dev/null 2>&1; then
      ( cd "$ICON_DIR" && npm install --silent ) \
        || echo "  (couldn't install sharp — keeping the default mark)"
    fi
    if [[ -d "$ICON_DIR/node_modules/sharp" ]]; then
      WORKSPACE_AGENT_NAME="$NAME" node "$ICON_DIR/gen-icons.mjs" \
        || echo "  (icon generation failed — keeping the default mark)"
    else
      echo "  (sharp not installed — keeping the default mark; run later:"
      echo "     npm --prefix scripts/icons install && WORKSPACE_AGENT_NAME='$NAME' node scripts/icons/gen-icons.mjs)"
    fi
    echo
  else
    echo "  (node not found — skipping icon generation; default mark ships as-is)"
    echo
  fi
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
