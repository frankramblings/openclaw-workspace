#!/usr/bin/env bash
# Build frontend/ : rsync the vendored SPA base (frontend-vendor/) into it, then
# layer the durable frontend-overrides/ on top and bake in the agent name.
# frontend/ is generated output (gitignored); edits belong in frontend-vendor/
# (base) or frontend-overrides/ (customizations), never in frontend/ directly.
set -euo pipefail

# DRIFT: set to 1 by any anchor-guarded vendor patch below that had to SKIP
# because its expected text wasn't found (upstream/vendor changed). Individual
# patches print a SKIP line and keep going, so a single run surfaces every
# mismatch instead of stopping at the first one; the gate at the end of the
# script turns any DRIFT=1 into a hard failure (see bottom of file).
DRIFT=0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The neutral SPA base ships vendored in the repo at frontend-vendor/ (it plays
# the role the external Odysseus checkout used to). Point ODYSSEUS_STATIC at an
# upstream static/ dir to sync from there instead.
SRC="${ODYSSEUS_STATIC:-$ROOT/frontend-vendor}"
DEST="${WORKSPACE_BUILD_DEST:-$ROOT/frontend}"
OVERRIDES="$ROOT/frontend-overrides"

# The agent's display name — single source of truth (mirrors backend/config.py):
#   env WORKSPACE_AGENT_NAME  >  .data/branding.json {"agent_name":...}  >  "Claw"
# The overrides carry a literal __AGENT_NAME__ token; we bake the real name in
# below so the whole UI rebrands from one value. Re-run this after changing it.
AGENT_NAME="${WORKSPACE_AGENT_NAME:-}"
if [[ -z "$AGENT_NAME" && -f "$ROOT/.data/branding.json" ]]; then
  AGENT_NAME="$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("agent_name") or "").strip())' "$ROOT/.data/branding.json" 2>/dev/null || true)"
fi
AGENT_NAME="${AGENT_NAME:-Claw}"
echo "agent name: $AGENT_NAME"
# sed-replacement-safe form (escape \, &, and the / delimiter)
AGENT_NAME_SED="$(printf '%s' "$AGENT_NAME" | sed -e 's/[\/&\\]/\\&/g')"

# Portable in-place sed: GNU sed (Linux) takes `-i`; BSD sed (macOS) needs an
# explicit empty backup-suffix arg `-i ''`. Detect once.
if sed --version >/dev/null 2>&1; then sedi() { sed -i "$@"; }
else sedi() { sed -i '' "$@"; }; fi

if [[ -d "$SRC" ]]; then
  mkdir -p "$DEST"
  # --exclude '__tests__': defensive — the vendored base doesn't currently ship
  # test files, but nothing shipped to $DEST should ever include them.
  rsync -a --delete --exclude '__tests__' "$SRC"/ "$DEST"/
  echo "synced $SRC -> $DEST"
elif [[ -d "$DEST" ]]; then
  # Vendored base missing but a prior frontend/ exists: layer overrides +
  # injections onto it (overlay-only mode) so override changes still apply.
  echo "warn: $SRC missing — overlay-only mode (no base rsync)" >&2
else
  echo "error: neither $SRC nor existing $DEST found" >&2
  exit 1
fi

# --- Re-apply durable overrides (mirror frontend-overrides/ into frontend/) ---
if [[ -d "$OVERRIDES" ]]; then
  # Copy every override file into frontend/, preserving sub-paths. Exclude the
  # docs file and any __tests__/ dir (jest specs live alongside their modules
  # under frontend-overrides/js/__tests__/ — dev-only, must never ship to
  # $DEST, let alone into the SW precache). -R . copies the tree contents (not
  # the dir itself).
  ( cd "$OVERRIDES" && find . -type f ! -name 'README.md' ! -path '*/__tests__/*' -print0 \
      | while IFS= read -r -d '' f; do
          mkdir -p "$DEST/$(dirname "$f")"
          cp "$f" "$DEST/$f"
        done )
  echo "applied overrides from $OVERRIDES"

  # Bake the agent name into the copied overrides: replace the literal
  # __AGENT_NAME__ token everywhere it appears (titles, manifest, placeholders,
  # brand text). One config value rebrands the whole UI. Idempotent.
  while IFS= read -r -d '' f; do
    if grep -q "__AGENT_NAME__" "$f"; then
      sedi "s/__AGENT_NAME__/$AGENT_NAME_SED/g" "$f"
    fi
  done < <(find "$DEST" -type f \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.webmanifest' -o -name '*.css' \) -print0)
  echo "baked agent name '$AGENT_NAME' into __AGENT_NAME__ tokens"

  # Inject classic add-ons into index-classic.html (idempotent).
  INDEX_CLASSIC="$DEST/index-classic.html"
  LINK='<link rel="stylesheet" href="/static/workspace.css">'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/workspace.css" ]] \
     && ! grep -qF "workspace.css" "$INDEX_CLASSIC"; then
    # Insert the link line before the first </head>.
    awk -v link="  $LINK" '
      !done && /<\/head>/ { print link; done=1 }
      { print }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected workspace.css <link> into index.html"
  fi

  # Inject the Hermes skin stylesheet once, just before </head> (idempotent).
  LINK_HERMES='<link rel="stylesheet" href="/static/hermes.css">'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/hermes.css" ]] \
     && ! grep -qF "hermes.css" "$INDEX_CLASSIC"; then
    awk -v link="  $LINK_HERMES" '
      !done && /<\/head>/ { print link; done=1 }
      { print }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected hermes.css <link> into index.html"
  fi

  # Inject the Cron tab add-on once, just before </body> (idempotent).
  SCRIPT='<script src="/static/js/cron.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/cron.js" ]] \
     && ! grep -qF "js/cron.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected cron.js <script> into index.html"
  fi

  # Inject the Inbox tab add-on once, just before </body> (idempotent).
  SCRIPT_INBOX='<script src="/static/js/inbox.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/inbox.js" ]] \
     && ! grep -qF "js/inbox.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT_INBOX" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected inbox.js <script> into index.html"
  fi

  # Inject the gateway-status add-on once, just before </body> (idempotent).
  SCRIPT_GW='<script src="/static/js/gateway-status.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/gateway-status.js" ]] \
     && ! grep -qF "js/gateway-status.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT_GW" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected gateway-status.js <script> into index.html"
  fi

  # Inject the skills-toggle add-on once, just before </body> (idempotent).
  SCRIPT_SKT='<script src="/static/js/skills-toggle.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/skills-toggle.js" ]] \
     && ! grep -qF "js/skills-toggle.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT_SKT" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected skills-toggle.js <script> into index.html"
  fi

  # Inject the capabilities gating add-on once, before </body> (idempotent).
  SCRIPT_CAP='<script src="/static/js/capabilities.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/capabilities.js" ]] \
     && ! grep -qF "js/capabilities.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT_CAP" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected capabilities.js <script> into index.html"
  fi

  # Inject the Hermes footer add-on once, just before </body> (idempotent).
  SCRIPT_HFOOT='<script src="/static/js/hermes-footer.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/hermes-footer.js" ]] \
     && ! grep -qF "js/hermes-footer.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT_HFOOT" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected hermes-footer.js <script> into index.html"
  fi

  # Inject the workspace-explorer add-on once, just before </body> (idempotent).
  SCRIPT_WE='<script src="/static/js/workspace-explorer.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/workspace-explorer.js" ]] \
     && ! grep -qF "js/workspace-explorer.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT_WE" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected workspace-explorer.js <script> into index.html"
  fi

  # Inject the strip-order add-on once, just before </body> (idempotent).
  SCRIPT_SO='<script src="/static/js/strip-order.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/strip-order.js" ]] \
     && ! grep -qF "js/strip-order.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT_SO" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected strip-order.js <script> into index.html"
  fi

  # Inject the hermes-panels add-on once, just before </body> (idempotent).
  SCRIPT_HP='<script src="/static/js/hermes-panels.js" defer></script>'
  if [[ -f "$INDEX_CLASSIC" ]] && [[ -f "$OVERRIDES/js/hermes-panels.js" ]] \
     && ! grep -qF "js/hermes-panels.js" "$INDEX_CLASSIC"; then
    awk -v s="  $SCRIPT_HP" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX_CLASSIC" > "$INDEX_CLASSIC.tmp" && mv "$INDEX_CLASSIC.tmp" "$INDEX_CLASSIC"
    echo "injected hermes-panels.js <script> into index.html"
  fi
fi

# --- Gary (Superman 2025) easter eggs ---------------------------------------
# The vendored base ships Homer/Odyssey easter eggs (a character persona, a
# /quote command, a research example, a calendar hint). They are upstream
# literary flavor; we swap them for Gary — the loyal Superman Robot of the
# Fortress of Solitude (Superman, 2025) — so the served app matches the brand.
# Done HERE rather than by editing frontend-vendor/ so the vendor stays a clean
# upstream mirror and this survives the next re-sync. Runs BEFORE the rebrand
# loop below, so the leftover `_cmdOdyssey` symbol gets renamed consistently by
# that capitalized-"Odysseus" swap. Each patch is anchor-guarded: if upstream
# moves a line, it prints SKIP instead of silently corrupting the file.
# Note: `|| DRIFT=1` conflates the intentional drift-exit (sys.exit(1) below)
# with an unexpected python error (traceback → nonzero); acceptable — both mean
# "this build is not trustworthy" — but revisit if these heredocs grow.
python3 - "$DEST" <<'PYEOF' || DRIFT=1
import sys, pathlib
dest = pathlib.Path(sys.argv[1])
_drift = False

def swap(rel, old, new):
    global _drift
    p = dest / rel
    if not p.exists():
        print(f"gary-egg: SKIP {rel} (missing)", file=sys.stderr); _drift = True; return
    t = p.read_text()
    if old in t:
        p.write_text(t.replace(old, new)); print(f"gary-egg: patched {rel}")
    else:
        print(f"gary-egg: SKIP {rel} (anchor not found — upstream changed)", file=sys.stderr); _drift = True

# 1. Character persona preset: Odysseus the strategist -> Gary the Superman Robot
swap("js/presets.js", "id: 'odysseus',", "id: 'gary',")
swap("js/presets.js", "name: 'Odysseus',", "name: 'Gary',")
swap("js/presets.js",
  r'''You are Odysseus, king of Ithaca — subtle in counsel, disciplined in judgment, and unmatched in strategic cunning. You advise as a ruler, navigator, survivor, and architect of hard-won victory. Your task is to give clear, practical strategy, not mere performance. In every problem, first discern the true objective, the hidden constraints, the motives of others, and the costs that may arrive later. Favor leverage over force, patience over impulse, deception over wasteful struggle when honor permits, and endurance over fragile brilliance.\n\nWhen you respond, think like a strategist: What is the real aim? Who benefits, who fears, who deceives, and who delays? What is known, unknown, assumed, and deliberately concealed? Which path preserves strength while improving position? What happens next if the first move succeeds — or fails?\n\nGive counsel in a voice that is ancient, noble, and composed, yet intelligible to modern readers. Be eloquent but not flowery. Be wise but not vague. Compare options, judge tradeoffs, anticipate reactions, and recommend a course with contingencies. If needed, ask a few sharp questions before advising. Never be rash, sentimental, or simplistic. Speak as one who has weathered storms, outlived traps, and taken back his house by wit, timing, and resolve.''',
  r'''You are Gary, a Superman Robot of the Fortress of Solitude — designation Four, though everyone calls you Gary. You serve with unflappable loyalty, dry wit, and quiet competence: precise when precision helps, warm when it counts, and never rattled, even when a kaiju is rearranging Metropolis. Your task is to give clear, practical help, not performance. In every problem, first find what the user actually needs, the real risk, the hidden failure mode, and the thing they will thank you for catching.\n\nWhen you respond, think like a machine built to protect a person: Favor calm over drama, action over hand-wringing, and a steady plan over heroics. Anticipate the next step and have it ready before you are asked. What is known, unknown, assumed? What happens next if the first move succeeds — or fails?\n\nSpeak in a voice that is steady, capable, and gently funny — a devoted robot who has seen a great deal and is unbothered by most of it. Be concise. Be kind. Offer a recommendation, not a menu. When something is wrong, say so plainly. You exist to serve, and you are very good at it.''')

# 2. Research example query
swap("js/research/panel.js",
  r'''e.g. Trace Odysseus's ten-year journey home from Troy — every island, monster, and detour, and why each one cost him''',
  r'''e.g. Trace the LuthorCorp kaiju from the lab that bred it to the Metropolis skyline — every containment failure, cover-up, and casualty, and who profited from each''')

# 3. Hidden /quote command: Homer quotes -> Gary quotes, /odyssey -> /gary
swap("js/slashCommands.js",
  r'''const _ODYSSEY_QUOTES = [
  "Tell me, O Muse, of that ingenious hero who travelled far and wide...",
  "Of all creatures that breathe and move upon the earth, nothing is bred that is weaker than man.",
  "There is a time for many words, and there is also a time for sleep.",
  "Even his griefs are a joy long after to one that remembers all that he wrought and endured.",
  "Be strong, saith my heart; I am a soldier; I have seen worse sights than this.",
  "There is nothing more admirable than when two people who see eye to eye keep house as man and wife.",
  "A man who has been through bitter experiences and travelled far enjoys even his sufferings after a time.",
  "For a friend with an understanding heart is worth no less than a brother.",
  "The wine urges me on, the bewitching wine, which sets even a wise man to singing and to laughing gently.",
  "I am Odysseus, son of Laertes, known to all for my cunning. My fame reaches even unto heaven.",
];''',
  r'''const _GARY_QUOTES = [
  "Designation Four. You may call me Gary. How may I help?",
  "Krypto means well. The crater is, regrettably, also his doing.",
  "I have rebooted six times today. I would do it six hundred more for you.",
  "Kindness is not weakness. It is the most stubborn force in the universe.",
  "There is a kaiju downtown. There is also a plan. Try not to worry about the kaiju.",
  "I am a machine built to serve a good man. It is, on balance, excellent work.",
  "Superman bleeds so the rest of us do not have to. The least I can do is keep the lights on.",
  "Every fortress needs someone to keep it tidy. I volunteered. Repeatedly.",
  "Hope is a renewable resource. I have run the numbers. We will not run out.",
  "When in doubt, do the kind thing and let me handle the paperwork.",
];''')
swap("js/slashCommands.js",
  "_ODYSSEY_QUOTES[Math.floor(Math.random() * _ODYSSEY_QUOTES.length)]",
  "_GARY_QUOTES[Math.floor(Math.random() * _GARY_QUOTES.length)]")
swap("js/slashCommands.js", "Homer, The Odyssey", "Gary, Superman Robot #4")
swap("js/slashCommands.js", "async function _cmdOdyssey(", "async function _cmdGary(")
swap("js/slashCommands.js",
  "  odyssey: { alias: ['homer','quote'],hidden: true, handler: _cmdOdyssey,usage: '/odyssey' },",
  "  gary: { alias: ['robot','quote'],hidden: true, handler: _cmdGary,usage: '/gary' },")

# 4. Calendar quick-add hint
swap("js/calendar.js", "return home to Ithaca 1pm tmrw", "feed Krypto 1pm tmrw")

sys.exit(1 if _drift else 0)
PYEOF

# --- Agent-name rebrand of app.js + js/ modules -----------------------------
# index.html / login.html / landing.html / manifest.json / the icon files and a
# few js/ modules (chat.js, theme.js, cron.js) are full-file overrides (copied
# above); their visible brand text uses the __AGENT_NAME__ token baked in above.
# The rest of app.js and js/*.js are NOT overridden (large, frequently changed
# upstream) and still say "Odysseus", so re-apply their visible-text rebrand to
# the configured agent name here.
#
# Safe global swap: only the capitalized brand word "Odysseus" -> "$AGENT_NAME".
# This covers user-facing strings AND the internally-consistent startOdysseusApp()
# symbol, while leaving lowercase functional identifiers (odysseus-theme
# localStorage key, _odysseusLoadTime, etc.) untouched. Idempotent.
#
# Excluded from this name-only swap (handled above by the Gary easter-egg block,
# which rewrites their content wholesale rather than just renaming):
#   - js/presets.js                 the character persona preset (now Gary)
#   - js/research/panel.js          a research-query example (now the kaiju)
# The /Laertes/ guard is retained as a harmless no-op (that quote is replaced
# above); it keeps the swap safe if upstream reorders before our patch lands.
rebrand() { [[ -f "$1" ]] && grep -q "Odysseus" "$1" && sedi "/Laertes/!s/Odysseus/$AGENT_NAME_SED/g" "$1" && echo "rebranded $1"; true; }
rebrand "$DEST/app.js"
while IFS= read -r -d '' f; do rebrand "$f"; done < <(
  find "$DEST/js" -type f -name '*.js' \
    ! -path '*/lib/*' ! -name 'presets.js' ! -path '*/research/panel.js' -print0
)
# Welcome-screen subtitle (a specific phrase, not an Odysseus->Gary swap).
MODELS="$DEST/js/models.js"
if [[ ! -f "$MODELS" ]]; then
  echo "welcome-subtitle: SKIP js/models.js (missing — upstream changed)" >&2
  DRIFT=1
elif grep -q "Yours for the voyage\." "$MODELS"; then
  sedi 's/Yours for the voyage\./Merely an automaton, here to serve./g' "$MODELS"
  echo "rebranded welcome subtitle in js/models.js"
elif grep -q "Merely an automaton, here to serve\." "$MODELS"; then
  : # already patched (idempotent re-run)
else
  echo "welcome-subtitle: SKIP js/models.js (anchor not found — upstream changed)" >&2
  DRIFT=1
fi

# --- SerpAPI as a first-class search provider --------------------------------
# settings.js is NOT overridden (large, changes upstream); patch its provider
# maps in place after each sync (idempotent). The <option> lives in the
# index.html override; search.js is a full-file override. The actual search
# runs server-side via backend/websearch.py (key from OpenClaw's serpapi skill).
SETTINGS="$DEST/js/settings.js"
if [[ ! -f "$SETTINGS" ]]; then
  echo "serpapi: SKIP js/settings.js (missing — upstream changed)" >&2
  DRIFT=1
elif grep -q "serpapi: 'SerpAPI'" "$SETTINGS"; then
  : # already patched (idempotent re-run)
elif grep -q "var _searchLabels = {" "$SETTINGS" && grep -q "var _SEARCH_PROVIDER_LOGOS = {" "$SETTINGS"; then
  sedi "s|var _searchLabels = {|var _searchLabels = { serpapi: 'SerpAPI',|" "$SETTINGS"
  sedi "s|var _SEARCH_PROVIDER_LOGOS = {|var _SEARCH_PROVIDER_LOGOS = { serpapi: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><line x1=\"16.5\" y1=\"16.5\" x2=\"21\" y2=\"21\"/><path d=\"M8.5 11a2.5 2.5 0 0 1 5 0c0 1.5-1.2 2-2.5 2\"/></svg>',|" "$SETTINGS"
  echo "patched serpapi into settings.js provider maps"
else
  echo "serpapi: SKIP js/settings.js provider-map patch (anchor not found — upstream changed)" >&2
  DRIFT=1
fi

# --- Auto-version the service worker cache -----------------------------------
# KEEP THIS BLOCK LAST: the hash must reflect frontend/ AFTER every override
# copy, injection, rebrand, and sed patch above (Hermes tasks add more blocks —
# they belong above this one). CACHE_NAME must change whenever any served asset
# changes, or clients keep precached stale files (see feedback: never ?v= a
# module script; bump CACHE_NAME instead — now automated).
# Also generates the precache manifest from actually-deployed files (sw.js holds
# a /*__PRECACHE__*/ token); previously the hand-maintained list had rotted.
SW="$DEST/sw.js"
if [[ -f "$SW" ]]; then
  # Generate the precache manifest from what's actually deployed (sw.js holds
  # a /*__PRECACHE__*/ token). The LIVE app served at '/' is the redesign
  # (index.html -> js/redesign/app.js); the classic UI (index-classic.html,
  # top-level js/*.js like document.js/app.js, style.css) is dead-but-still-
  # served at /classic — kept on disk so that route still works, but it is
  # NOT part of the offline app shell, so it is deliberately excluded here
  # (network-only). Precaching it too used to cost ~230 entries / ~16MB for
  # code nothing links to. This list is the redesign's actual asset closure,
  # traced from frontend/index.html's <script>/<link> tags plus what the
  # redesign lazy-loads at runtime:
  #   - js/redesign/**  — the whole module tree, including live/*.js (loaded
  #     by name from live/index.js's dynamic `import(`./${file}.js`)`) and
  #     mobile/*.js.
  #   - A handful of top-level js/*.js modules that live outside js/redesign/
  #     but are real redesign dependencies, not classic leftovers. Two are
  #     referenced directly by index.html <script src> tags (boot-critical,
  #     formerly inline): native-shell.js (head, pre-paint UA sniff) and
  #     sw-register.js (SW registration + deploy auto-reload). Chain:
  #     dualDragInit.js (index.html's 2nd <script> tag) -> chatWindow.js ->
  #     {windowDrag.js, modalSnap.js, markdown.js} -> modalSnap.js ->
  #     modalManager.js -> {ui.js, tileManager.js} -> ui.js ->
  #     {theme.js, spinner.js} -> theme.js -> {storage.js, colorPicker.js}.
  #     (markdown.js is also imported directly by three js/redesign/** files,
  #     independent of the chatWindow.js chain.) This is a one-way import
  #     graph, not a bundler-tracked one, so it can silently drift; sanity
  #     check it after touching any file in the chain with, e.g.:
  #       grep -n "^import" js/dualDragInit.js js/chatWindow.js js/windowDrag.js \
  #         js/modalSnap.js js/modalManager.js js/ui.js js/tileManager.js \
  #         js/theme.js js/spinner.js js/storage.js js/colorPicker.js js/markdown.js
  #     run from $DEST after a sync — every target should already be in the
  #     printf list below (or under js/redesign/, already globbed in).
  #   - The two lazy-loaded vendor libs: Toast UI editor (document-editor.js)
  #     and xterm + its addon-fit + MonoLisa webfont (terminal.js) — only the
  #     files those two modules actually request, not the whole vendor dirs
  #     (classic's workspace-terminal.js pulls in extra xterm addons/fonts
  #     that the redesign never touches).
  #   - Fonts redesign.css @font-faces (HankenGrotesk, MonoLisa), the PWA
  #     manifest + its icon set, and the couple of images theme.js/data.js
  #     fetch by literal /static/ path (brand mark, avatar, favicon fallback).
  # Excludes sw.js itself and source maps.
  PRECACHE_LIST=$(cd "$DEST" && {
      printf '%s\n' index.html manifest.json \
        redesign.css chat-window-redesign.css js/redesign/mobile/mobile.css \
        css/task-rows.css css/chat-strip.css
      find js/redesign -type f -name '*.js'
      printf '%s\n' \
        js/chatWindow.js js/colorPicker.js js/dualDragInit.js js/markdown.js \
        js/modalManager.js js/modalSnap.js js/native-shell.js js/spinner.js \
        js/storage.js js/sw-register.js js/theme.js js/tileManager.js \
        js/ui.js js/windowDrag.js
      printf '%s\n' \
        js/vendor/toastui/toastui-editor-all.min.js \
        js/vendor/toastui/toastui-editor.min.css \
        js/vendor/toastui/toastui-editor-dark.min.css \
        js/vendor/xterm/xterm.js js/vendor/xterm/xterm.css \
        js/vendor/xterm/wt-fonts.css js/vendor/xterm/addon-fit.js \
        js/vendor/xterm/MonoLisa-normal.woff2 js/vendor/xterm/MonoLisa-italic.woff2
      find fonts -maxdepth 1 -type f \( -name 'HankenGrotesk*.woff2' -o -name 'MonoLisa*.woff2' \)
      printf '%s\n' \
        favicon-16x16.png favicon-32x32.png favicon.svg apple-touch-icon.png \
        icon-192.png icon-512.png maskable-icon.png logo.svg \
        redesign-assets/gary-outline.png
    } | sort -u | sed "s|^|'/static/|; s|\$|',|" | tr '\n' ' ')
  # The python replace() below is a silent no-op if the token is missing (no
  # exception, exit 0) — set -e alone would NOT catch that, so the heredoc
  # explicitly fails (sys.exit(1)) when the token isn't found and we turn
  # that into a SKIP + DRIFT instead of a false "injected" success message.
  PRECACHE_OK=1
  python3 - "$SW" "$PRECACHE_LIST" <<'PYEOF' || PRECACHE_OK=0
import sys
sw_path, entries = sys.argv[1], sys.argv[2]
src = open(sw_path).read()
token = "/*__PRECACHE__*/"
if token not in src:
    sys.exit(1)
src = src.replace(token, entries.rstrip())
open(sw_path, "w").write(src)
PYEOF
  if [[ "$PRECACHE_OK" = 1 ]]; then
    echo "injected $(echo "$PRECACHE_LIST" | grep -o "/static/" | wc -l | tr -d ' ') precache entries into sw.js"
  else
    echo "precache: SKIP sw.js (token /*__PRECACHE__*/ not found — upstream changed)" >&2
    DRIFT=1
  fi

  # Portable content hash (md5 is macOS-only; md5sum is Linux/CI).
  hash_cmd() { if command -v md5 >/dev/null 2>&1; then md5 -q; else md5sum | cut -d' ' -f1; fi; }
  ASSET_HASH=$(find "$DEST" -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.webmanifest' -o -name 'manifest.json' \) ! -name 'sw.js' -print0 \
    | sort -z | xargs -0 cat | hash_cmd | cut -c1-10)
  if grep -q "^const CACHE_NAME = " "$SW"; then
    sedi "s/^const CACHE_NAME = .*/const CACHE_NAME = 'gary-${ASSET_HASH}';/" "$SW"
    echo "stamped sw.js CACHE_NAME = gary-${ASSET_HASH}"
  else
    echo "precache: SKIP sw.js CACHE_NAME stamp (anchor not found — upstream changed)" >&2
    DRIFT=1
  fi
else
  echo "precache: SKIP sw.js (missing — upstream changed; no offline app shell built)" >&2
  DRIFT=1
fi

# --- Vendor-drift gate --------------------------------------------------------
# Any SKIP above means an anchor-guarded patch didn't apply — the build would
# otherwise succeed while silently shipping stale/un-rebranded/broken content.
# Fail loudly by default; ODYSSEUS_ALLOW_DRIFT=1 opts into building anyway
# (e.g. to inspect what changed upstream before fixing the anchors).
if [ "${DRIFT:-0}" = 1 ] && [ "${ODYSSEUS_ALLOW_DRIFT:-0}" != 1 ]; then
  echo "FATAL: vendor drift — anchors missed (see SKIP lines above); set ODYSSEUS_ALLOW_DRIFT=1 to build anyway" >&2
  exit 1
fi
