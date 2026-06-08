#!/usr/bin/env bash
# Install OpenClaw Workspace as a macOS LaunchAgent (runs on login, restarts on
# crash). Fills deploy/ai.openclaw.workspace.plist.template with this machine's
# paths and loads it. Re-run to update. Binds 127.0.0.1 by default — expose over
# a tailnet with `tailscale serve --https=8443 127.0.0.1:<port>`, not 0.0.0.0.
#
# Usage:
#   scripts/install-launchagent.sh                 # 127.0.0.1:8800
#   scripts/install-launchagent.sh --port 8800 --host 127.0.0.1
#   scripts/install-launchagent.sh --uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="ai.openclaw.workspace"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$ROOT/deploy/$LABEL.plist.template"

HOST="127.0.0.1"
PORT="8800"
UNINSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ "$UNINSTALL" == 1 ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

[[ "$(uname)" == "Darwin" ]] || { echo "LaunchAgents are macOS-only. On Linux, use a systemd unit running: uvicorn backend.app:app --host $HOST --port $PORT" >&2; exit 1; }

PYTHON="$ROOT/.venv/bin/python3"
[[ -x "$PYTHON" ]] || PYTHON="$(command -v python3)"
[[ -x "$PYTHON" ]] || { echo "no python3 found; create the venv first (python3 -m venv .venv)" >&2; exit 1; }

# Keep the venv + a sane base PATH (node is handy for the icon generator).
BIN_PATH="$ROOT/.venv/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LOG="${TMPDIR:-/tmp}/openclaw-workspace.launchd.log"
ERRLOG="${TMPDIR:-/tmp}/openclaw-workspace.launchd.err.log"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__PYTHON__|$PYTHON|g" \
    -e "s|__HOST__|$HOST|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__REPO__|$ROOT|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PATH__|$BIN_PATH|g" \
    -e "s|__LOG__|$LOG|g" \
    -e "s|__ERRLOG__|$ERRLOG|g" \
    "$TEMPLATE" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "installed + started $LABEL on $HOST:$PORT"
echo "  plist:  $PLIST"
echo "  logs:   $LOG  /  $ERRLOG"
echo "  manage: launchctl kickstart -k gui/$(id -u)/$LABEL   (restart)"
echo "          scripts/install-launchagent.sh --uninstall   (remove)"
echo
echo "Expose over a tailnet (recommended over binding 0.0.0.0):"
echo "  tailscale serve --bg --https=8443 127.0.0.1:$PORT"
