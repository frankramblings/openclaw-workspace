#!/usr/bin/env bash
# Copy the Odysseus SPA into ./frontend. The frontend is reused, not vendored —
# re-run this when Odysseus's static/ changes.
set -euo pipefail

SRC="${ODYSSEUS_STATIC:-$HOME/odysseus/static}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/frontend"

if [[ ! -d "$SRC" ]]; then
  echo "error: Odysseus static dir not found at $SRC" >&2
  echo "set ODYSSEUS_STATIC=/path/to/odysseus/static and retry" >&2
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete "$SRC"/ "$DEST"/
echo "synced $SRC -> $DEST"
