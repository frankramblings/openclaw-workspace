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

## Fortress loader (boot loader + AI-thinking spinner)

The animated "fortress crystals" SVG replaces the boot loader and every
AI-thinking spinner. Pieces (all must stay in sync):

- **fortress-loading-48.svg** — the canonical asset (copied from
  `~/.openclaw/workspace/tmp/`). NOT inlined as-is: its internal `<style>` has a
  `:root` rule and generic `.crystal`/`.shard` classes that would leak page-wide
  when inlined. The markup is duplicated *namespaced* (`fl-*` classes, no
  `<style>`) in `index.html` (boot loader, 88px) and `js/spinner.js`
  (`FORTRESS_BODY`).
- **workspace.css** — carries the single copy of the `fl-*` animation rules +
  `fl-grow`/`fl-shard` keyframes + reduced-motion fallback.
- **index.html** — `#app-loader` contains the inline fortress SVG (was the
  ASCII `▁▂▃` wave); the frame-cycling script is gone, only the 5s failsafe
  remains (app.js still does the real removal).
- **js/spinner.js** — FULL-FILE override: `create()`'s text animations
  (`spinner`/`wave`/`sinewave`/default) all render the fortress, which covers
  every in-chat AI-thinking spinner (Initializing / Thinking / Generating
  response / reconnect banners). Canvas `createWhirlpool`/`createLoadingRow`
  are untouched (list/image loading, not AI thinking). Adds
  `createFortress(size)` with the same `{element, stop, destroy}` shape as
  `createWhirlpool`. Re-merge when upstream spinner.js changes.
- **js/chat.js** — two AI-activity call sites swapped to `createFortress`:
  the live-think header (12px) and the rewrite/reconnect placeholder (18px).

## Gary rebrand (UI named "Gary", not "Odysseus")

The UI is branded **Gary**. The brand lives here as durable overrides so it
survives the Odysseus sync:

- **index.html, login.html, landing.html** — full-file overrides carrying the
  visible "Gary" text (titles, sidebar/welcome/login brand, route titles,
  manifest names, placeholders) and the brand-mark logo markup. Because they're
  whole-file copies, upstream Odysseus changes to these files do **not** flow
  through until re-merged. When upstream changes meaningfully, diff and re-apply
  the rebrand (the renames are mechanical: visible `Odysseus` → `Gary`, plus the
  boat `<svg>`/favicon swaps below).
- **manifest.json** — full-file override (`name`/`short_name` = Gary, icon set).
- **logo.svg / favicon.svg / favicon-16x16.png / favicon-32x32.png /
  apple-touch-icon.png / icon-192.png / icon-512.png / maskable-icon.png** —
  the Gary helmet assets, generated from `scripts/icons/gary.src.svg`. Rebuild
  with `cd scripts/icons && npm run gen` (writes into both `frontend/` and here).
  - `logo.svg` is a single-color **mask** shape (opaque ink, transparent
    elsewhere). In-UI logos are `<span class="… brand-mark">` masked by it, so
    they inherit the live theme accent (`--brand-color`) — the same way the old
    boat `<svg fill="currentColor">` did. The `.brand-mark` rule lives in
    `workspace.css` (main app) and inline in login.html / landing.html.
  - `favicon.svg` + the PNGs bake in the current accent (cyan `#4fe3d1`) since a
    tab/launcher icon can't read page color. Re-run the generator after changing
    the accent in `scripts/icons/gen-icons.mjs`.
- **js/theme.js** — full-file override. `_updateFavicon()` regenerates the
  favicon from the theme accent on every theme apply; upstream it rebuilt the
  boat for the root path, which overwrote the static Gary `<link>` on boot
  ("Gary flashes, then reverts to the boat"). The root branch now rebuilds the
  **Gary** mark instead, tinted to the live accent — it fetches `/static/logo.svg`
  (mono mask shape, ink `#000`) and recolors the ink to the accent, so the tab
  icon tracks the theme exactly as the boat did. Per-route glyphs are unchanged.
- **app.js + most js/ modules** are NOT overridden (large, frequently changed
  upstream). Their visible "Odysseus" strings (assistant role label, "Odysseus
  Chat", the `/tour` text, settings/email/cookbook help, welcome subtitle, …)
  are rebranded by a `sed` step in `scripts/sync-frontend.sh` that runs after the
  override copy: a capitalized `Odysseus` → `Gary` swap, which leaves lowercase
  functional identifiers (`odysseus-theme` key, `_odysseusLoadTime`) intact.
  **Intentionally excluded** (literary/persona content, not chrome): `js/presets.js`
  (the "Odysseus" character persona), `js/research/panel.js` (a myth example
  query), and any line matching `/Laertes/` (the Homer "I am Odysseus…" quote in
  `/quote`). The welcome subtitle "Yours for the voyage." is replaced with
  "Merely an automaton, here to serve." by a separate sed in the same step.

## Adding an override

1. Drop the file here at its `frontend/`-relative path (additive CSS/JS preferred
   over full-file overrides — they survive upstream changes).
2. If it's a new stylesheet/script that must load, add an injection step to
   `scripts/sync-frontend.sh`.
3. Run `scripts/sync-frontend.sh` and verify in the browser.
