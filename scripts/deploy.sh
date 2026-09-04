#!/usr/bin/env bash
# Deploy BOTH tenants from main in one run: gate, Frank, publish, Marissa,
# and a conditional idle-gated restart of her gateway. Every step prints
# "[step] ..." and every section prints its duration; under --dry-run every
# command that would run is appended to $DEPLOY_LOG (the test reads that log).
#
# Usage: scripts/deploy.sh [--dry-run] [--skip-marissa] [--skip-tests --i-know]
#                          [--force-gateway] [--gateway-wait SECONDS]
#
# Rollback (also printed at the end): see docs/SHIPPING.md "Two tenants".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY=0; SKIP_M=0; SKIP_TESTS=0; I_KNOW=0; FORCE_GW=0; GW_WAIT=600
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --skip-marissa) SKIP_M=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --i-know) I_KNOW=1; shift ;;
    --force-gateway) FORCE_GW=1; shift ;;
    --gateway-wait) GW_WAIT="${2:?}"; shift 2 ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
if [[ "$SKIP_TESTS" == 1 && "$I_KNOW" != 1 ]]; then
  echo "--skip-tests needs --i-know (you are shipping untested code to two tenants)" >&2; exit 2
fi

# Tool seams (tests point these at stubs; production leaves them unset).
PY="${DEPLOY_PYTHON:-$ROOT/.venv/bin/python}"
NODE="${DEPLOY_NODE:-node}"
SUDO="${DEPLOY_SUDO:-sudo}"
SYSTEMCTL="${DEPLOY_SYSTEMCTL:-systemctl}"
CURL="${DEPLOY_CURL:-curl}"
GIT="${DEPLOY_GIT:-git}"
DIST_GLOB="${DEPLOY_DIST_GLOB:-/usr/lib/node_modules/openclaw/dist/claude-live-session-*.js}"
M_USER="marissa"
M_HOME="${DEPLOY_MARISSA_HOME:-$(getent passwd "$M_USER" | cut -d: -f6)}"
if [[ -z "$M_HOME" ]]; then
  echo "cannot resolve the home directory for $M_USER; set DEPLOY_MARISSA_HOME" >&2; exit 1
fi
M_REPO="$M_HOME/openclaw-workspace"
SCAN_CMD="${DEPLOY_SCAN_CMD:-scripts/publish-scan.sh}"
SYNC_CMD="${DEPLOY_SYNC_CMD:-scripts/sync-frontend.sh}"
PUBLISH_CMD="${DEPLOY_PUBLISH_CMD:-scripts/prepare-public.sh --yes}"
LOG="${DEPLOY_LOG:-}"
FRANK_URL="http://127.0.0.1:8800"
M_URL="http://127.0.0.1:8801"

say()  { printf '[%s] %s\n' "$1" "$2"; }
# Only planned commands are logged; real runs are observed by what they touch.
logc() { [[ -n "$LOG" && "$DRY" == 1 ]] && printf '%s\n' "$*" >> "$LOG" || true; }
run()  { logc "$@"; if [[ "$DRY" == 1 ]]; then say plan "$*"; else "$@"; fi; }
# Read-only commands run even under --dry-run.
ro()   { "$@"; }
as_m() { run "$SUDO" -n -u "$M_USER" "$@"; }
# Nothing runs as her under --dry-run except the preflight probe, so this is
# plan-only there and prints nothing; callers fall back to a placeholder.
as_m_ro() {
  if [[ "$DRY" == 1 ]]; then logc "$SUDO" -n -u "$M_USER" "$@"; return 0; fi
  "$SUDO" -n -u "$M_USER" "$@"
}
wait_http() { # url, seconds
  local url="$1" secs="$2" i=0
  while (( i < secs )); do
    if "$CURL" -fsS -m 3 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

# ---- preflight ----------------------------------------------------------------
T0=$SECONDS
say preflight "branch $($GIT branch --show-current 2>/dev/null || echo '?')"
if [[ "${DEPLOY_PREFLIGHT_CLEAN:-0}" != 1 ]]; then
  [[ "$($GIT branch --show-current)" == "main" ]] || { echo "deploy from main only" >&2; exit 1; }
  [[ -z "$($GIT status --porcelain --untracked-files=no)" ]] || { echo "working tree has tracked changes; commit first" >&2; exit 1; }
fi
# Only her tenant needs sudo; Frank's unit is a user unit.
if [[ "$SKIP_M" != 1 ]]; then
  ro "$SUDO" -n true || { echo "sudo -n is not available; run 'sudo -v' first, or deploy with --skip-marissa" >&2; exit 1; }
  ro "$SUDO" -n -u "$M_USER" true || { echo "cannot act as $M_USER" >&2; exit 1; }
fi
OLD_PUBLIC="$($GIT rev-parse public 2>/dev/null || echo "")"
say time "preflight took $((SECONDS - T0))s"

# ---- gate ---------------------------------------------------------------------
T0=$SECONDS
if [[ "$SKIP_TESTS" != 1 ]]; then
  say gate:backend "pytest"; ro "$PY" -m pytest backend/tests -q -p no:cacheprovider --continue-on-collection-errors
  say gate:frontend "node --test"; ro "$NODE" --test frontend-overrides/js/__tests__/*.test.js scripts/test/*.mjs
else
  say gate:backend "SKIPPED (--skip-tests)"; say gate:frontend "SKIPPED (--skip-tests)"
fi
say gate:scan "publish scan"; ro bash -c "$SCAN_CMD"
say time "gate took $((SECONDS - T0))s"

# ---- frank --------------------------------------------------------------------
T0=$SECONDS
say frank:sync "sync-frontend"; run bash -c "$SYNC_CMD"
say frank:restart "openclaw-workspace.service"; run "$SYSTEMCTL" --user restart openclaw-workspace.service
say frank:smoke "$FRANK_URL"
if [[ "$DRY" != 1 ]]; then
  wait_http "$FRANK_URL/api/capabilities" 60 || { echo "Frank's service did not come back" >&2; exit 1; }
  ro "$CURL" -fsS -m 5 "$FRANK_URL/api/changes/stats" >/dev/null
  ro "$CURL" -fsS -m 5 -X POST "$FRANK_URL/api/changes/rebuild" >/dev/null || say frank:smoke "changes rebuild skipped"
fi
say time "frank took $((SECONDS - T0))s"

# ---- publish ------------------------------------------------------------------
T0=$SECONDS
say publish "prepare-public"; run bash -c "$PUBLISH_CMD"
NEW_PUBLIC="$($GIT rev-parse public 2>/dev/null || echo "$OLD_PUBLIC")"
say time "publish took $((SECONDS - T0))s"

# ---- marissa ------------------------------------------------------------------
GW_RESTARTED=0
if [[ "$SKIP_M" != 1 ]]; then
  T0=$SECONDS
  TS="$(date +%Y%m%d-%H%M%S)"
  say marissa:backup ".data -> .data.bak-$TS"
  as_m bash -c "cd '$M_REPO' && cp -a .data '.data.bak-$TS' && ls -dt .data.bak-* | tail -n +4 | xargs -r rm -rf"
  M_OLD="$(as_m_ro bash -c "cd '$M_REPO' && git rev-parse HEAD" 2>/dev/null || echo '?')"
  M_OLD="${M_OLD:-(dry)}"
  say marissa:reset "fetch + reset to origin/public (was $M_OLD)"
  as_m bash -c "cd '$M_REPO' && git fetch -q origin public && git reset -q --hard origin/public"
  if [[ -n "$OLD_PUBLIC" && -n "$NEW_PUBLIC" ]] && [[ -n "$($GIT diff --name-only "$OLD_PUBLIC" "$NEW_PUBLIC" -- pyproject.toml 2>/dev/null)" ]]; then
    say marissa:deps "pyproject changed: pip install -e ."; as_m bash -c "cd '$M_REPO' && .venv/bin/pip install -q -e ."
  else
    say marissa:deps "unchanged"
  fi
  say marissa:sync "sync-frontend"; as_m bash -c "cd '$M_REPO' && scripts/sync-frontend.sh"
  say marissa:restart "openclaw-workspace-marissa.service"; run "$SUDO" -n "$SYSTEMCTL" restart openclaw-workspace-marissa.service
  say marissa:smoke "$M_URL/marissa"
  if [[ "$DRY" != 1 ]]; then
    wait_http "$M_URL/marissa/api/capabilities" 60 || wait_http "$M_URL/api/capabilities" 10 \
      || { echo "Marissa's service did not come back; rollback: sudo -u $M_USER git -C $M_REPO reset --hard $M_OLD && restore .data.bak-$TS" >&2; exit 1; }
    ro "$CURL" -fsS -m 5 -X POST "$M_URL/marissa/api/changes/rebuild" >/dev/null || say marissa:smoke "changes rebuild skipped"
  fi

  say time "marissa took $((SECONDS - T0))s"

  # gateway: only for a gateway-side change or a missing patch marker, and only when idle
  T0=$SECONDS
  NEED_GW=0
  if [[ "$FORCE_GW" == 1 ]]; then NEED_GW=1; fi
  if [[ -n "$OLD_PUBLIC" && -n "$NEW_PUBLIC" ]] && [[ -n "$($GIT diff --name-only "$OLD_PUBLIC" "$NEW_PUBLIC" -- deploy/gateway-patches 2>/dev/null)" ]]; then NEED_GW=1; fi
  if ! grep -qs 'CLI_STEER' $DIST_GLOB; then NEED_GW=1; fi
  if [[ "$NEED_GW" == 1 ]]; then
    if [[ "$DRY" == 1 ]]; then
      say marissa:gateway "plan: wait for her gateway to be idle (up to ${GW_WAIT}s), then restart openclaw-gateway-marissa.service"
    else
      say marissa:gateway "waiting for her gateway to be idle (up to ${GW_WAIT}s)"
      waited=0; idle=0
      while (( waited < GW_WAIT )); do
        inflight="$(as_m_ro cat "$M_REPO/.data/turns_inflight.json" 2>/dev/null || echo '{"inflight":{}}')"
        if [[ "$inflight" == *'"inflight":{}'* || "$inflight" == *'"inflight": {}'* ]]; then idle=1; break; fi
        if [[ "$(printf '%s' "$inflight" | "$PY" -c 'import json,sys
try:
    d = json.load(sys.stdin); print(0 if d.get("inflight") else 1)
except Exception:
    print(1)' 2>/dev/null || echo 1)" == 1 ]]; then idle=1; break; fi
        sleep 5; waited=$((waited + 5))
      done
      if [[ "$idle" == 1 ]]; then
        run "$SUDO" -n "$SYSTEMCTL" restart openclaw-gateway-marissa.service; GW_RESTARTED=1
      else
        say marissa:gateway "SKIPPED gateway restart: her gateway stayed busy for ${GW_WAIT}s; rerun with --force-gateway when she is idle"
      fi
    fi
  else
    say marissa:gateway "no gateway-side change; not restarted"
  fi
  say time "gateway took $((SECONDS - T0))s"
fi

# ---- summary ------------------------------------------------------------------
say summary "main $($GIT rev-parse --short HEAD 2>/dev/null || echo '?'); public $OLD_PUBLIC -> $NEW_PUBLIC; marissa skipped=$SKIP_M gateway_restarted=$GW_RESTARTED dry_run=$DRY"
if [[ "$SKIP_M" != 1 ]]; then
  say rollback "sudo -u $M_USER git -C $M_REPO reset --hard ${M_OLD:-<old sha>}; restore $M_REPO/.data.bak-${TS:-<ts>}; sudo systemctl restart openclaw-workspace-marissa.service"
fi
