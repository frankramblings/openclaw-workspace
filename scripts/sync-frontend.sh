#!/usr/bin/env bash
# Copy the Odysseus SPA into ./frontend, then re-apply our durable overrides.
# The frontend is reused (not vendored): re-run this when Odysseus's static/
# changes. Workspace-specific changes live in ../frontend-overrides and are
# layered back on top here so the rsync --delete never clobbers them.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ODYSSEUS_STATIC:-$HOME/odysseus/static}"
DEST="$ROOT/frontend"
OVERRIDES="$ROOT/frontend-overrides"

if [[ ! -d "$SRC" ]]; then
  echo "error: Odysseus static dir not found at $SRC" >&2
  echo "set ODYSSEUS_STATIC=/path/to/odysseus/static and retry" >&2
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete "$SRC"/ "$DEST"/
echo "synced $SRC -> $DEST"

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
fi

# --- Gary rebrand of app.js + js/ modules -----------------------------------
# index.html / login.html / landing.html / manifest.json / the icon files and a
# few js/ modules (chat.js, theme.js, cron.js) are full-file overrides (copied
# above), so their "Gary" branding survives the rsync automatically. The rest of
# app.js and js/*.js are NOT overridden (large, frequently changed upstream), so
# re-apply their visible-text rebrand here.
#
# Safe global swap: only the capitalized brand word "Odysseus" -> "Gary". This
# covers user-facing strings AND the internally-consistent startOdysseusApp()
# symbol, while leaving lowercase functional identifiers (odysseus-theme
# localStorage key, _odysseusLoadTime, etc.) untouched. Idempotent.
#
# Excluded — intentionally NOT rebranded (literary/persona content, not chrome):
#   - js/presets.js                 the "Odysseus" character persona preset
#   - js/research/panel.js          a research-query example about the myth
#   - any line matching /Laertes/   the Homer "I am Odysseus…" quote in /quote
rebrand() { [[ -f "$1" ]] && grep -q "Odysseus" "$1" && sed -i '' '/Laertes/!s/Odysseus/Gary/g' "$1" && echo "rebranded $1"; }
rebrand "$DEST/app.js"
while IFS= read -r -d '' f; do rebrand "$f"; done < <(
  find "$DEST/js" -type f -name '*.js' \
    ! -path '*/lib/*' ! -name 'presets.js' ! -path '*/research/panel.js' -print0
)
# Welcome-screen subtitle (a specific phrase, not an Odysseus->Gary swap).
MODELS="$DEST/js/models.js"
if [[ -f "$MODELS" ]] && grep -q "Yours for the voyage\." "$MODELS"; then
  sed -i '' 's/Yours for the voyage\./Merely an automaton, here to serve./g' "$MODELS"
  echo "rebranded welcome subtitle in js/models.js"
fi

# --- SerpAPI as a first-class search provider --------------------------------
# settings.js is NOT overridden (large, changes upstream); patch its provider
# maps in place after each sync (idempotent). The <option> lives in the
# index.html override; search.js is a full-file override. The actual search
# runs server-side via backend/websearch.py (key from OpenClaw's serpapi skill).
SETTINGS="$DEST/js/settings.js"
if [[ -f "$SETTINGS" ]] && ! grep -q "serpapi: 'SerpAPI'" "$SETTINGS"; then
  sed -i '' "s|var _searchLabels = {|var _searchLabels = { serpapi: 'SerpAPI',|" "$SETTINGS"
  sed -i '' "s|var _SEARCH_PROVIDER_LOGOS = {|var _SEARCH_PROVIDER_LOGOS = { serpapi: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><line x1=\"16.5\" y1=\"16.5\" x2=\"21\" y2=\"21\"/><path d=\"M8.5 11a2.5 2.5 0 0 1 5 0c0 1.5-1.2 2-2.5 2\"/></svg>',|" "$SETTINGS"
  echo "patched serpapi into settings.js provider maps"
fi
