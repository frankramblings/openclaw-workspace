#!/usr/bin/env bash
# Tests the JS syntax gates in sync-frontend.sh.
#
# No test runner exists for the build scripts; this is the next best thing and
# runs in CI-less reality via: bash scripts/test-sync-frontend-gate.sh
#
# The real sync-frontend.sh is copied into a synthetic throwaway root (its own
# frontend-vendor/ + frontend-overrides/ + frontend/), so the live frontend/ is
# never touched. Every case runs with ODYSSEUS_ALLOW_DRIFT=1: the synthetic
# vendor deliberately lacks the anchors the real vendor patches expect, so drift
# is expected and irrelevant here — and waving drift through while the syntax
# gates still fire is exactly the "syntax errors are NOT escapable" property
# these tests are asserting.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/sync-frontend.sh"
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Build a synthetic root. $1 = root path.
mkroot() {
  local r="$1"
  rm -rf "$r"; mkdir -p "$r/scripts" "$r/frontend-vendor/js" "$r/frontend-overrides/js"
  cp "$SCRIPT" "$r/scripts/sync-frontend.sh"
  printf '<!doctype html><title>__AGENT_NAME__</title>\n' > "$r/frontend-vendor/index.html"
  printf 'export const boot = 1;\n' > "$r/frontend-vendor/app.js"
  # A single-quoted brand string: the rebrand pass rewrites Odysseus -> the
  # agent name in place, which case 4 uses to corrupt the BUILD (not the source).
  printf "export const who = 'Odysseus';\n" > "$r/frontend-vendor/js/brand.js"
  cat > "$r/frontend-vendor/sw.js" <<'SWEOF'
const CACHE_NAME = 'gary-vendor';
const PRECACHE = [
  /*__PRECACHE__*/
];
SWEOF
  printf 'export const extra = 2;\n' > "$r/frontend-overrides/js/extra.js"
}

run() { # $1 = root, rest = env assignments; prints combined output, returns exit code
  local r="$1"; shift
  ( cd "$r" && env ODYSSEUS_ALLOW_DRIFT=1 WORKSPACE_AGENT_NAME=Gary "$@" \
      bash "$r/scripts/sync-frontend.sh" 2>&1 )
}

echo "sync-frontend.sh — JS syntax gate"
echo "── cases ───────────────────────────────────────────────"

# --- 1. clean sources build successfully ------------------------------------
R="$TMP/clean"; mkroot "$R"
out="$(run "$R")"; rc=$?
[[ $rc -eq 0 ]] && ok "clean build exits 0" || bad "clean build exited $rc (expected 0)"
grep -q 'js-syntax: ok (source' <<<"$out" && ok "pre-flight gate ran on sources" \
  || bad "pre-flight gate did not report on sources"
grep -q 'js-syntax: ok (build' <<<"$out" && ok "post-build gate ran on output" \
  || bad "post-build gate did not report on output"
[[ -f "$R/frontend/js/extra.js" ]] && ok "clean build produced output" \
  || bad "clean build produced no output"

# --- 2. broken OVERRIDE is caught before $DEST is touched -------------------
R="$TMP/badoverride"; mkroot "$R"
# The exact 2026-07-31 bug: curly quotes used as string delimiters.
printf 'export const msg = \xe2\x80\x98oops\xe2\x80\x99;\n' > "$R/frontend-overrides/js/extra.js"
mkdir -p "$R/frontend"; printf 'sentinel\n' > "$R/frontend/LAST_GOOD"
out="$(run "$R")"; rc=$?
[[ $rc -ne 0 ]] && ok "broken override fails the build (exit $rc)" \
  || bad "broken override built successfully (expected failure)"
grep -q 'refusing to build' <<<"$out" && ok "reports refusing to build" \
  || bad "missing 'refusing to build' message"
grep -q 'SyntaxError' <<<"$out" && ok "surfaces the SyntaxError with file:line" \
  || bad "did not surface a SyntaxError"
[[ -f "$R/frontend/LAST_GOOD" && ! -e "$R/frontend/js" ]] \
  && ok "\$DEST left untouched (last good build intact)" \
  || bad "\$DEST was mutated despite the pre-flight failure"

# --- 3. broken VENDOR is caught too -----------------------------------------
R="$TMP/badvendor"; mkroot "$R"
printf 'export const boot = ;\n' > "$R/frontend-vendor/app.js"
out="$(run "$R")"; rc=$?
[[ $rc -ne 0 ]] && ok "broken vendor fails the build (exit $rc)" \
  || bad "broken vendor built successfully (expected failure)"
grep -q 'refusing to build' <<<"$out" && ok "vendor failure hits the same gate" \
  || bad "vendor failure missing 'refusing to build'"

# --- 4. corruption introduced BY the script's own patches -------------------
# Sources are valid (a /*__PRECACHE__*/ comment parses fine), so pre-flight
# passes — but here the token sits at statement position instead of inside the
# array literal, so the injection emits `'/static/a', '/static/b',` as a bare
# statement, which is a SyntaxError. Only the post-build gate can catch this
# class: damage done by the build itself, downstream of any source check.
R="$TMP/patchcorrupt"; mkroot "$R"
cat > "$R/frontend-vendor/sw.js" <<'SWEOF'
const CACHE_NAME = 'gary-vendor';
const PRECACHE = [];
/*__PRECACHE__*/
SWEOF
out="$(run "$R")"; rc=$?
[[ $rc -ne 0 ]] && ok "patch-induced corruption fails the build (exit $rc)" \
  || bad "patch-induced corruption shipped (expected failure)"
grep -q 'js-syntax: ok (source' <<<"$out" && ok "pre-flight passed (sources were valid)" \
  || bad "pre-flight should have passed on valid sources"
grep -q 'do not serve it' <<<"$out" && ok "post-build gate flags the broken build" \
  || bad "post-build gate did not flag the broken build"

# --- 5. the generated service worker is parsed as well ----------------------
# sw.js is rewritten by the precache injection + CACHE_NAME stamp; the gate runs
# after that chain, so the generated file is covered.
R="$TMP/badsw"; mkroot "$R"
run "$R" >/dev/null 2>&1
grep -q "^const CACHE_NAME = 'gary-" "$R/frontend/sw.js" \
  && ok "sw.js was stamped before the gate inspected it" \
  || bad "sw.js was not stamped"
node --check "$R/frontend/sw.js" 2>/dev/null \
  && ok "generated sw.js parses" || bad "generated sw.js does not parse"

# --- 6. unsafe agent names are refused before anything is written -----------
# The name is pasted verbatim into JS strings, HTML text/attributes and JSON,
# so any character that needs escaping in one of those is refused outright.
# "O'Brien" is the motivating case: it used to rewrite `const who = 'Odysseus';`
# into `const who = 'O'Brien';` and ship a dead app.
while IFS= read -r nm; do
  R="$TMP/badname"; mkroot "$R"
  mkdir -p "$R/frontend"; printf 'sentinel\n' > "$R/frontend/LAST_GOOD"
  out="$( cd "$R" && env ODYSSEUS_ALLOW_DRIFT=1 WORKSPACE_AGENT_NAME="$nm" \
          bash "$R/scripts/sync-frontend.sh" 2>&1 )"; rc=$?
  if [[ $rc -ne 0 ]] && grep -q 'cannot be safely' <<<"$out" && [[ ! -e "$R/frontend/js" ]]; then
    ok "refuses unsafe agent name: $nm"
  else
    bad "did NOT refuse unsafe agent name: $nm (exit $rc)"
  fi
done <<'NAMES'
O'Brien
Say "Hi"
Back`tick
Doll$ar
Angle<br>
Amp&Co
Back\slash
NAMES

R="$TMP/nlname"; mkroot "$R"
out="$( cd "$R" && env ODYSSEUS_ALLOW_DRIFT=1 WORKSPACE_AGENT_NAME="$(printf 'Two\nLines')" \
        bash "$R/scripts/sync-frontend.sh" 2>&1 )"; rc=$?
[[ $rc -ne 0 ]] && grep -q 'control character' <<<"$out" \
  && ok "refuses agent name with a newline" \
  || bad "did NOT refuse agent name with a newline (exit $rc)"

# --- 7. legitimate names still build, and actually get baked in -------------
while IFS= read -r nm; do
  R="$TMP/goodname"; mkroot "$R"
  out="$( cd "$R" && env ODYSSEUS_ALLOW_DRIFT=1 WORKSPACE_AGENT_NAME="$nm" \
          bash "$R/scripts/sync-frontend.sh" 2>&1 )"; rc=$?
  if [[ $rc -eq 0 ]] && grep -qF "<title>$nm</title>" "$R/frontend/index.html" 2>/dev/null; then
    ok "accepts and bakes in agent name: $nm"
  else
    bad "rejected legitimate agent name: $nm (exit $rc)"
  fi
done <<'NAMES'
Gary
Gary Workspace
Gaëtan
agent-7
v1.2_beta
NAMES

echo "────────────────────────────────────────────────────────"
[[ $fail -eq 0 ]] && echo "all cases passed" || echo "FAILURES above"
exit $fail
