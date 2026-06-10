#!/usr/bin/env bash
# Build frontend/ : rsync the vendored SPA base (frontend-vendor/) into it, then
# layer the durable frontend-overrides/ on top and bake in the agent name.
# frontend/ is generated output (gitignored); edits belong in frontend-vendor/
# (base) or frontend-overrides/ (customizations), never in frontend/ directly.
set -euo pipefail

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
  rsync -a --delete "$SRC"/ "$DEST"/
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
  # docs file. -R . copies the tree contents (not the dir itself).
  ( cd "$OVERRIDES" && find . -type f ! -name 'README.md' -print0 \
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
  done < <(find "$DEST" -type f \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.webmanifest' \) -print0)
  echo "baked agent name '$AGENT_NAME' into __AGENT_NAME__ tokens"

  # Inject the workspace stylesheet once, just before </head> (idempotent).
  INDEX="$DEST/index.html"
  LINK='<link rel="stylesheet" href="/static/workspace.css">'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/workspace.css" ]] \
     && ! grep -qF "workspace.css" "$INDEX"; then
    # Insert the link line before the first </head>.
    awk -v link="  $LINK" '
      !done && /<\/head>/ { print link; done=1 }
      { print }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected workspace.css <link> into index.html"
  fi

  # Inject the Hermes skin stylesheet once, just before </head> (idempotent).
  LINK_HERMES='<link rel="stylesheet" href="/static/hermes.css">'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/hermes.css" ]] \
     && ! grep -qF "hermes.css" "$INDEX"; then
    awk -v link="  $LINK_HERMES" '
      !done && /<\/head>/ { print link; done=1 }
      { print }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected hermes.css <link> into index.html"
  fi

  # Inject the Cron tab add-on once, just before </body> (idempotent).
  SCRIPT='<script src="/static/js/cron.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/cron.js" ]] \
     && ! grep -qF "js/cron.js" "$INDEX"; then
    awk -v s="  $SCRIPT" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected cron.js <script> into index.html"
  fi

  # Inject the Inbox tab add-on once, just before </body> (idempotent).
  SCRIPT_INBOX='<script src="/static/js/inbox.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/inbox.js" ]] \
     && ! grep -qF "js/inbox.js" "$INDEX"; then
    awk -v s="  $SCRIPT_INBOX" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected inbox.js <script> into index.html"
  fi

  # Inject the gateway-status add-on once, just before </body> (idempotent).
  SCRIPT_GW='<script src="/static/js/gateway-status.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/gateway-status.js" ]] \
     && ! grep -qF "js/gateway-status.js" "$INDEX"; then
    awk -v s="  $SCRIPT_GW" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected gateway-status.js <script> into index.html"
  fi

  # Inject the skills-toggle add-on once, just before </body> (idempotent).
  SCRIPT_SKT='<script src="/static/js/skills-toggle.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/skills-toggle.js" ]] \
     && ! grep -qF "js/skills-toggle.js" "$INDEX"; then
    awk -v s="  $SCRIPT_SKT" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected skills-toggle.js <script> into index.html"
  fi

  # Inject the capabilities gating add-on once, before </body> (idempotent).
  SCRIPT_CAP='<script src="/static/js/capabilities.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/capabilities.js" ]] \
     && ! grep -qF "js/capabilities.js" "$INDEX"; then
    awk -v s="  $SCRIPT_CAP" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected capabilities.js <script> into index.html"
  fi

  # Inject the Hermes footer add-on once, just before </body> (idempotent).
  SCRIPT_HFOOT='<script src="/static/js/hermes-footer.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/hermes-footer.js" ]] \
     && ! grep -qF "js/hermes-footer.js" "$INDEX"; then
    awk -v s="  $SCRIPT_HFOOT" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected hermes-footer.js <script> into index.html"
  fi
fi

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
# Excluded — intentionally NOT rebranded (literary/persona content, not chrome):
#   - js/presets.js                 the "Odysseus" character persona preset
#   - js/research/panel.js          a research-query example about the myth
#   - any line matching /Laertes/   the Homer "I am Odysseus…" quote in /quote
rebrand() { [[ -f "$1" ]] && grep -q "Odysseus" "$1" && sedi "/Laertes/!s/Odysseus/$AGENT_NAME_SED/g" "$1" && echo "rebranded $1"; true; }
rebrand "$DEST/app.js"
while IFS= read -r -d '' f; do rebrand "$f"; done < <(
  find "$DEST/js" -type f -name '*.js' \
    ! -path '*/lib/*' ! -name 'presets.js' ! -path '*/research/panel.js' -print0
)
# Welcome-screen subtitle (a specific phrase, not an Odysseus->Gary swap).
MODELS="$DEST/js/models.js"
if [[ -f "$MODELS" ]] && grep -q "Yours for the voyage\." "$MODELS"; then
  sedi 's/Yours for the voyage\./Merely an automaton, here to serve./g' "$MODELS"
  echo "rebranded welcome subtitle in js/models.js"
fi

# --- SerpAPI as a first-class search provider --------------------------------
# settings.js is NOT overridden (large, changes upstream); patch its provider
# maps in place after each sync (idempotent). The <option> lives in the
# index.html override; search.js is a full-file override. The actual search
# runs server-side via backend/websearch.py (key from OpenClaw's serpapi skill).
SETTINGS="$DEST/js/settings.js"
if [[ -f "$SETTINGS" ]] && ! grep -q "serpapi: 'SerpAPI'" "$SETTINGS"; then
  sedi "s|var _searchLabels = {|var _searchLabels = { serpapi: 'SerpAPI',|" "$SETTINGS"
  sedi "s|var _SEARCH_PROVIDER_LOGOS = {|var _SEARCH_PROVIDER_LOGOS = { serpapi: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><line x1=\"16.5\" y1=\"16.5\" x2=\"21\" y2=\"21\"/><path d=\"M8.5 11a2.5 2.5 0 0 1 5 0c0 1.5-1.2 2-2.5 2\"/></svg>',|" "$SETTINGS"
  echo "patched serpapi into settings.js provider maps"
fi

# --- Auto-version the service worker cache -----------------------------------
# KEEP THIS BLOCK LAST: the hash must reflect frontend/ AFTER every override
# copy, injection, rebrand, and sed patch above (Hermes tasks add more blocks —
# they belong above this one). CACHE_NAME must change whenever any served asset
# changes, or clients keep precached stale files (see feedback: never ?v= a
# module script; bump CACHE_NAME instead — now automated).
SW="$DEST/sw.js"
if [[ -f "$SW" ]]; then
  ASSET_HASH=$(find "$DEST" -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.webmanifest' \) ! -name 'sw.js' -print0 \
    | sort -z | xargs -0 cat | md5 -q | cut -c1-10)
  sedi "s/^const CACHE_NAME = .*/const CACHE_NAME = 'gary-${ASSET_HASH}';/" "$SW"
  echo "stamped sw.js CACHE_NAME = gary-${ASSET_HASH}"
fi
