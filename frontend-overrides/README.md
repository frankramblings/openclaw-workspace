# frontend-overrides

Durable, git-tracked customizations layered **on top of** the Odysseus SPA.

## Why

`frontend/` is gitignored and `scripts/sync-frontend.sh` does `rsync --delete`
from `~/odysseus/static`, so any edit made directly in `frontend/` is wiped on
the next sync. Odysseus is still actively developed and ships fixes we want, so
we keep syncing — but workspace-specific changes live **here** and are re-applied
*after* each sync.

## Layout

This directory **mirrors the `frontend/` tree**. After the rsync, the sync
script copies everything here into `frontend/`, overwriting the synced files:

```
frontend-overrides/
  workspace.css      → frontend/workspace.css   (served at /static/workspace.css)
  js/chat.js         → frontend/js/chat.js       (FULL-FILE override, see below)
```

- **workspace.css** — additive styling (e.g. Inbox source-chip colors). The sync
  script injects `<link rel="stylesheet" href="/static/workspace.css">` into
  `index.html` before `</head>` (idempotent).
- **js/chat.js** — a **full-file** override carrying the tool-card interleaving
  fix (`_toolNodesById`: pair each `tool_output` to its own card so cards don't
  spin forever when tools interleave). Because it's a whole-file copy, Odysseus's
  own `chat.js` changes do **not** flow through until this copy is re-merged.
  When upstream `chat.js` changes meaningfully, diff and re-apply the fix.

## Adding an override

1. Drop the file here at its `frontend/`-relative path (additive CSS/JS preferred
   over full-file overrides — they survive upstream changes).
2. If it's a new stylesheet/script that must load, add an injection step to
   `scripts/sync-frontend.sh`.
3. Run `scripts/sync-frontend.sh` and verify in the browser.
