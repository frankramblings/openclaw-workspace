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
fi
