#!/usr/bin/env bash
# Deploy BOTH tenants from main in one run: gate, Frank, publish, Marissa,
# and a conditional idle-gated restart of her gateway. Every step prints
# "[step] ..." and every section prints its duration; under --dry-run every
# command that would run is appended to $DEPLOY_LOG (the test reads that log).
#
# Usage: scripts/deploy.sh [--dry-run] [--skip-marissa] [--skip-tests --i-know]
#                          [--force-gateway] [--force-deps]
#                          [--gateway-wait SECONDS]
#
# --force-deps reinstalls backend/requirements.txt into her venv even when the
# deployed diff did not touch it. Use it when the parity report says she is
# missing packages.
#
# Rollback (also printed at the end): see docs/SHIPPING.md "Two tenants".
#
# DEPLOY_PREFLIGHT_CLEAN=1 skips BOTH preflight checks (deploy-from-main and
# clean-tree) and the behind-origin fetch. It is for tests and worktree dry
# runs only, never a real deploy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY=0; SKIP_M=0; SKIP_TESTS=0; I_KNOW=0; FORCE_GW=0; FORCE_DEPS=0; GW_WAIT=600
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --skip-marissa) SKIP_M=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --i-know) I_KNOW=1; shift ;;
    --force-gateway) FORCE_GW=1; shift ;;
    --force-deps) FORCE_DEPS=1; shift ;;
    --gateway-wait) GW_WAIT="${2:?}"; shift 2 ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
if [[ ! "$GW_WAIT" =~ ^[0-9]+$ ]]; then
  echo "--gateway-wait wants a non-negative whole number of seconds, got: $GW_WAIT" >&2; exit 2
fi
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
# Two statements, not one: under `set -e` a failing getent inside a default
# expansion would kill the script before the friendly message could print.
M_HOME="${DEPLOY_MARISSA_HOME:-}"
if [[ -z "$M_HOME" ]]; then
  M_HOME="$(getent passwd "$M_USER" | cut -d: -f6 || true)"
fi
if [[ -z "$M_HOME" ]]; then
  echo "cannot resolve the home directory for $M_USER; set DEPLOY_MARISSA_HOME" >&2; exit 1
fi
M_REPO="$M_HOME/openclaw-workspace"
SCAN_CMD="${DEPLOY_SCAN_CMD:-scripts/prepare-public.sh --check}"
SYNC_CMD="${DEPLOY_SYNC_CMD:-scripts/sync-frontend.sh}"
PUBLISH_CMD="${DEPLOY_PUBLISH_CMD:-scripts/prepare-public.sh --yes}"
LOG="${DEPLOY_LOG:-}"
FRANK_URL="http://127.0.0.1:8800"
M_URL="http://127.0.0.1:8801"
# Her workspace is proxied under /marissa, but the proxy STRIPS that prefix:
# on 127.0.0.1:8801 the app answers /api/... at the root, and /marissa/api/...
# is a 404. Probe the root.
GW_PORT_M=18889

say()  { printf '[%s] %s\n' "$1" "$2"; }
# Only planned commands are logged; real runs are observed by what they touch.
logc() { [[ -n "$LOG" && "$DRY" == 1 ]] && printf '%s\n' "$*" >> "$LOG" || true; }
run()  { logc "$@"; if [[ "$DRY" == 1 ]]; then say plan "$*"; else "$@"; fi; }
# Read-only commands run even under --dry-run, and are logged there too.
ro()   { logc "$@"; "$@"; }
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
http_code() { # url -> the HTTP status, or 000 when the request never landed
  "$CURL" -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || echo 000
}
# The SPA index behind a login wall answers 302, without one 200. Anything
# else (000, 404, 5xx) means the static mount is broken.
smoke_static() { # url-base -> echoes the code, returns non-zero when it is bad
  local code; code="$(http_code "$1/static/index.html")"
  printf '%s' "$code"
  case "$code" in 200|302) return 0 ;; *) return 1 ;; esac
}

# ---- preflight ----------------------------------------------------------------
T0=$SECONDS
say preflight "branch $($GIT branch --show-current 2>/dev/null || echo '?')"
if [[ "${DEPLOY_PREFLIGHT_CLEAN:-0}" != 1 ]]; then
  [[ "$($GIT branch --show-current)" == "main" ]] || { echo "deploy from main only" >&2; exit 1; }
  # Untracked files count here: prepare-public.sh's clean-tree check sees them
  # too, so catching them now fails the run before anything is restarted.
  [[ -z "$($GIT status --porcelain)" ]] || { echo "working tree is not clean (tracked or untracked changes); commit, stash or delete them first" >&2; $GIT status --short >&2; exit 1; }
  ro "$GIT" fetch -q origin || say preflight "could not fetch origin; skipping the behind-origin check"
  BEHIND="$($GIT rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
  if [[ "$BEHIND" =~ ^[0-9]+$ ]] && (( BEHIND > 0 )); then
    say preflight "WARNING: main is $BEHIND commit(s) behind origin/main; you may be shipping a stale tree"
  fi
fi
if [[ -f .data/branding.json ]] && ! grep -q '"user_name"' .data/branding.json; then
  say preflight "WARNING: .data/branding.json has no user_name; prompts will say 'the user' until it is set"
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
say gate:scan "$SCAN_CMD"; ro bash -c "$SCAN_CMD"
say time "gate took $((SECONDS - T0))s"

# ---- frank --------------------------------------------------------------------
T0=$SECONDS
FRANK_SMOKE="(dry)"
say frank:sync "sync-frontend"; run bash -c "$SYNC_CMD"
say frank:restart "openclaw-workspace.service"; run "$SYSTEMCTL" --user restart openclaw-workspace.service
say frank:smoke "$FRANK_URL"
if [[ "$DRY" != 1 ]]; then
  # /api/health is the one path the auth gate allowlists, so it answers even
  # with a share secret set; every other path 401s to an anonymous curl.
  wait_http "$FRANK_URL/api/health" 60 || { echo "Frank's service did not answer on /api/health" >&2; exit 1; }
  if FRANK_SMOKE="$(smoke_static "$FRANK_URL")"; then
    say frank:smoke "static index $FRANK_SMOKE"
  else
    echo "Frank's static index answered $FRANK_SMOKE (want 200 or 302)" >&2; exit 1
  fi
else
  say plan "$CURL $FRANK_URL/api/health (readiness) and $FRANK_URL/static/index.html (smoke)"
fi
say time "frank took $((SECONDS - T0))s"

# ---- publish ------------------------------------------------------------------
T0=$SECONDS
say publish "prepare-public"; run bash -c "$PUBLISH_CMD"
NEW_PUBLIC="$($GIT rev-parse public 2>/dev/null || echo "$OLD_PUBLIC")"
say time "publish took $((SECONDS - T0))s"

# ---- marissa ------------------------------------------------------------------
GW_RESTARTED=0
M_SMOKE="(skipped)"
if [[ "$SKIP_M" != 1 ]]; then
  M_SMOKE="(dry)"
  # Her current sha is both the rollback target and the honest baseline for
  # "what is this deploy actually changing on her box", so read and validate it
  # before anything else in her section, including the gateway decision.
  M_OLD="$(as_m_ro bash -c "cd '$M_REPO' && git rev-parse HEAD" 2>/dev/null || echo '')"
  if [[ "$DRY" == 1 ]]; then
    M_OLD="${M_OLD:-(dry)}"
  elif [[ ! "$M_OLD" =~ ^[0-9a-f]{40}$ ]]; then
    echo "could not read her current sha; refusing to reset $M_REPO" >&2; exit 1
  fi
  # OLD_PUBLIC..NEW_PUBLIC goes empty whenever prepare-public.sh ran an extra
  # time between deploys, which would silently skip a needed action. Her real
  # HEAD is the truthful baseline when we have it.
  if [[ "$M_OLD" =~ ^[0-9a-f]{40}$ ]]; then
    BASE_SHA="$M_OLD"; BASE_KIND="her HEAD"
  else
    BASE_SHA="$OLD_PUBLIC"; BASE_KIND="previous public"
  fi
  say marissa:baseline "diffing $BASE_KIND ${BASE_SHA:-<none>} -> ${NEW_PUBLIC:-<none>}"

  # Whether her gateway needs a restart is decided BEFORE anything touches her
  # tenant, because the idle check below has to happen first.
  NEED_GW=0
  if [[ "$FORCE_GW" == 1 ]]; then NEED_GW=1; fi
  if [[ -n "$BASE_SHA" && -n "$NEW_PUBLIC" ]] && [[ -n "$($GIT diff --name-only "$BASE_SHA" "$NEW_PUBLIC" -- deploy/gateway-patches 2>/dev/null)" ]]; then NEED_GW=1; fi
  if ! grep -qs 'CLI_STEER' $DIST_GLOB; then NEED_GW=1; fi

  # Idle gate FIRST: restarting her workspace calls turn_state.sweep_boot(),
  # which empties `inflight`, so a post-restart read would always look idle and
  # we would restart her gateway underneath a live turn.
  T0=$SECONDS
  GW_IDLE=0
  if [[ "$NEED_GW" == 1 ]]; then
    if [[ "$DRY" == 1 ]]; then
      say marissa:gateway "plan: wait for her gateway to be idle (up to ${GW_WAIT}s) BEFORE touching her tenant, then restart openclaw-gateway-marissa.service after her workspace restart"
    else
      say marissa:gateway "waiting for her gateway to be idle (up to ${GW_WAIT}s)"
      INFLIGHT_F="$M_REPO/.data/turns_inflight.json"
      waited=0
      while (( waited < GW_WAIT )); do
        # Missing file = a fresh tenant = idle. Present but unreadable or
        # unparseable = assume busy, never restart mid-turn.
        if ! as_m_ro test -e "$INFLIGHT_F" >/dev/null 2>&1; then GW_IDLE=1; break; fi
        if inflight="$(as_m_ro cat "$INFLIGHT_F" 2>/dev/null)"; then
          if [[ "$inflight" == *'"inflight":{}'* || "$inflight" == *'"inflight": {}'* ]]; then GW_IDLE=1; break; fi
          if [[ "$(printf '%s' "$inflight" | "$PY" -c 'import json,sys
try:
    d = json.load(sys.stdin); print(0 if d.get("inflight") else 1)
except Exception:
    print(0)' 2>/dev/null || echo 0)" == 1 ]]; then GW_IDLE=1; break; fi
        else
          say marissa:gateway "could not read turns_inflight.json; treating her gateway as busy"
        fi
        sleep 5; waited=$((waited + 5))
      done
      if [[ "$GW_IDLE" != 1 ]]; then
        say marissa:gateway "SKIPPED gateway restart: her gateway stayed busy for ${GW_WAIT}s; her workspace still deploys, rerun with --force-gateway when she is idle"
      fi
    fi
  else
    say marissa:gateway "no gateway-side change; not restarted"
  fi
  say time "gateway check took $((SECONDS - T0))s"

  T0=$SECONDS
  TS="$(date +%Y%m%d-%H%M%S)"
  say marissa:backup ".data -> .data.bak-$TS"
  as_m bash -c "cd '$M_REPO' && cp -a .data '.data.bak-$TS' && ls -dt .data.bak-* | tail -n +4 | xargs -r rm -rf"
  say marissa:reset "fetch + reset to origin/public (was $M_OLD)"
  as_m bash -c "cd '$M_REPO' && git fetch -q origin public && git reset -q --hard origin/public"
  # pyproject.toml declares no dependencies here; backend/requirements.txt is
  # the real list, so that is what her venv gets.
  DEPS_CHANGED=""
  if [[ -n "$BASE_SHA" && -n "$NEW_PUBLIC" ]]; then
    DEPS_CHANGED="$($GIT diff --name-only "$BASE_SHA" "$NEW_PUBLIC" -- backend/requirements.txt pyproject.toml 2>/dev/null || true)"
  fi
  if [[ "$FORCE_DEPS" == 1 || -n "$DEPS_CHANGED" ]]; then
    if [[ "$FORCE_DEPS" == 1 ]]; then say marissa:deps "--force-deps: pip install -r backend/requirements.txt"
    else say marissa:deps "requirements changed: pip install -r backend/requirements.txt"; fi
    as_m bash -c "cd '$M_REPO' && .venv/bin/pip install -q -r backend/requirements.txt"
  else
    say marissa:deps "unchanged"
  fi
  say marissa:sync "sync-frontend"; as_m bash -c "cd '$M_REPO' && scripts/sync-frontend.sh"
  say marissa:restart "openclaw-workspace-marissa.service"; run "$SUDO" -n "$SYSTEMCTL" restart openclaw-workspace-marissa.service
  say marissa:smoke "$M_URL"
  if [[ "$DRY" != 1 ]]; then
    wait_http "$M_URL/api/health" 60 \
      || { echo "Marissa's service did not answer on $M_URL/api/health; rollback:" >&2
           echo "  $SUDO -n -u $M_USER bash -c \"cd $M_REPO && git reset --hard $M_OLD && rm -rf .data && cp -a .data.bak-$TS .data\"" >&2
           echo "  $SUDO -n $SYSTEMCTL restart openclaw-workspace-marissa.service" >&2
           exit 1; }
    if M_SMOKE="$(smoke_static "$M_URL")"; then
      say marissa:smoke "static index $M_SMOKE"
    else
      echo "Marissa's static index answered $M_SMOKE (want 200 or 302); rollback:" >&2
      echo "  $SUDO -n -u $M_USER bash -c \"cd $M_REPO && git reset --hard $M_OLD && rm -rf .data && cp -a .data.bak-$TS .data\"" >&2
      echo "  $SUDO -n $SYSTEMCTL restart openclaw-workspace-marissa.service" >&2
      exit 1
    fi
  else
    say plan "$CURL $M_URL/api/health (readiness) and $M_URL/static/index.html (smoke)"
  fi
  say time "marissa took $((SECONDS - T0))s"

  # gateway restart: only when it was needed AND she was idle before we started
  T0=$SECONDS
  if [[ "$NEED_GW" == 1 && "$GW_IDLE" == 1 ]]; then
    run "$SUDO" -n "$SYSTEMCTL" restart openclaw-gateway-marissa.service; GW_RESTARTED=1
    if [[ "$DRY" != 1 ]]; then
      gw_ok=0; i=0
      while (( i < 60 )); do
        if [[ "$(http_code "http://127.0.0.1:$GW_PORT_M/")" != "000" ]]; then gw_ok=1; break; fi
        sleep 1; i=$((i + 1))
      done
      if [[ "$gw_ok" == 1 ]]; then
        say marissa:gateway "her gateway is answering on 127.0.0.1:$GW_PORT_M"
      else
        # Informational only; the workspace deploy already succeeded.
        say marissa:gateway "her gateway did not answer on 127.0.0.1:$GW_PORT_M within 60s; check openclaw-gateway-marissa.service"
      fi
    fi
  fi
  say time "gateway took $((SECONDS - T0))s"
fi

# ---- summary ------------------------------------------------------------------
say summary "main $($GIT rev-parse --short HEAD 2>/dev/null || echo '?'); public $OLD_PUBLIC -> $NEW_PUBLIC; marissa skipped=$SKIP_M gateway_restarted=$GW_RESTARTED dry_run=$DRY"
say summary "smoke: frank static index $FRANK_SMOKE; marissa static index $M_SMOKE"

# ---- parity -------------------------------------------------------------------
# Read-only, never fails the run: what actually differs between the two tenants
# right now. Per-tenant settings live outside the repo (unit Environment,
# .data/branding.json, the venv), so drift is invisible in git.
PARITY_PY='import re
try:
    from importlib.metadata import version
except Exception:
    raise SystemExit(0)
miss = []
try:
    fh = open("backend/requirements.txt")
except Exception:
    raise SystemExit(0)
for line in fh:
    line = line.split("#")[0].strip()
    if not line or line.startswith("-"):
        continue
    name = re.split(r"[<>=!~\[;\s]", line)[0].strip()
    if not name:
        continue
    n = re.sub(r"[-_.]+", "-", name).lower()
    try:
        version(n)
    except Exception:
        miss.append(n)
print("PKGS:" + (",".join(miss) if miss else "none"))'
PARITY_B64="$(printf '%s' "$PARITY_PY" | base64 -w0 2>/dev/null || printf '%s' "$PARITY_PY" | base64 | tr -d '\n')"
PARITY_RUNNER="import base64;exec(base64.b64decode('$PARITY_B64'))"

# Environment=VAR=value VAR2=value2 -> the one value we asked for, else "-"
env_val() { # <var> <systemctl-show-output>
  local v
  v="$(printf '%s' "${2:-}" | tr ' ' '\n' | sed -n "s/^\(Environment=\)\?${1}=//p" | tail -n1)"
  printf '%s' "${v:--}"
}
# Anything that is not a PKGS: line is stub noise or a broken venv, not data.
pkgs_of() { # <raw output> -> comma list, "none", or "-"
  local line
  line="$(printf '%s' "${1:-}" | tr -d '\r' | sed -n 's/^PKGS://p' | tail -n1)"
  printf '%s' "${line:--}"
}

parity_report() {
  local f_sha f_env f_user f_title f_sugg f_pkgs_raw f_pkgs
  f_sha="$($GIT rev-parse --short HEAD 2>/dev/null || echo '-')"
  f_env="$("$SYSTEMCTL" --user show openclaw-workspace.service -p Environment 2>/dev/null || true)"
  f_user="$(env_val WORKSPACE_USER_NAME "$f_env")"
  if [[ "$f_user" == "-" && -f "$ROOT/.data/branding.json" ]]; then
    f_user="$(sed -n 's/.*"user_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/.data/branding.json" 2>/dev/null | head -n1 || true)"
    f_user="${f_user:--}"
  fi
  f_title="$(env_val WORKSPACE_TITLE_MODEL "$f_env")"
  f_sugg="$(env_val WORKSPACE_SUGGEST_MODEL "$f_env")"
  f_pkgs_raw="$("$PY" -c "$PARITY_RUNNER" 2>/dev/null || true)"
  f_pkgs="$(pkgs_of "$f_pkgs_raw")"
  say parity "frank: sha=$f_sha user_name=$f_user title_model=$f_title suggest_model=$f_sugg missing_pkgs=$f_pkgs"
  if [[ "$f_pkgs" != "none" && "$f_pkgs" != "-" ]]; then
    say parity "WARN: frank missing packages: $f_pkgs"
  fi

  if [[ "$SKIP_M" == 1 ]]; then
    say parity "marissa: skipped (--skip-marissa)"
    return 0
  fi

  local m_sha m_env m_user m_title m_sugg m_pkgs_raw m_pkgs m_brand pub_sha
  m_sha="$(as_m_ro bash -c "cd '$M_REPO' && git rev-parse --short HEAD" 2>/dev/null || true)"
  m_sha="${m_sha:-(dry)}"
  m_env="$("$SYSTEMCTL" show openclaw-workspace-marissa.service -p Environment 2>/dev/null || true)"
  m_user="$(env_val WORKSPACE_USER_NAME "$m_env")"
  if [[ "$m_user" == "-" ]]; then
    m_brand="$(as_m_ro cat "$M_REPO/.data/branding.json" 2>/dev/null || true)"
    m_user="$(printf '%s' "$m_brand" | sed -n 's/.*"user_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)"
    m_user="${m_user:--}"
  fi
  m_title="$(env_val WORKSPACE_TITLE_MODEL "$m_env")"
  m_sugg="$(env_val WORKSPACE_SUGGEST_MODEL "$m_env")"
  m_pkgs_raw="$(as_m_ro bash -c "cd '$M_REPO' && .venv/bin/python -c \"$PARITY_RUNNER\"" 2>/dev/null || true)"
  m_pkgs="$(pkgs_of "$m_pkgs_raw")"
  if [[ "$DRY" == 1 ]]; then m_pkgs="(dry)"; fi
  say parity "marissa: sha=$m_sha user_name=$m_user title_model=$m_title suggest_model=$m_sugg missing_pkgs=$m_pkgs"
  if [[ "$m_pkgs" != "none" && "$m_pkgs" != "-" && "$m_pkgs" != "(dry)" ]]; then
    say parity "WARN: marissa missing packages: $m_pkgs (rerun with --force-deps)"
  fi

  # user_name differs by design, so it is never a DIFF line.
  [[ "$f_title" == "$m_title" ]] || say parity "DIFF: title_model frank=$f_title marissa=$m_title"
  [[ "$f_sugg"  == "$m_sugg"  ]] || say parity "DIFF: suggest_model frank=$f_sugg marissa=$m_sugg"
  [[ "$f_pkgs"  == "$m_pkgs"  ]] || say parity "DIFF: missing_pkgs frank=$f_pkgs marissa=$m_pkgs"

  pub_sha="$($GIT rev-parse --short public 2>/dev/null || echo '-')"
  if [[ "$m_sha" == "$pub_sha" ]]; then
    say parity "OK: marissa on public $pub_sha"
  else
    say parity "DIFF: marissa sha=$m_sha public=$pub_sha"
  fi
}
parity_report || say parity "report failed (non-fatal)"

if [[ "$SKIP_M" != 1 ]]; then
    R_SHA="${M_OLD:-}"
  if [[ ! "$R_SHA" =~ ^[0-9a-f]{40}$ ]]; then R_SHA="<previous sha>"; fi
  say rollback "$SUDO -n -u $M_USER bash -c \"cd $M_REPO && git reset --hard $R_SHA && rm -rf .data && cp -a .data.bak-${TS:-<ts>} .data\""
  say rollback "$SUDO -n $SYSTEMCTL restart openclaw-workspace-marissa.service"
  if [[ "$R_SHA" == "<previous sha>" ]]; then
    say rollback "find <previous sha> with: $SUDO -n -u $M_USER bash -c \"cd $M_REPO && git reflog\""
  fi
fi
