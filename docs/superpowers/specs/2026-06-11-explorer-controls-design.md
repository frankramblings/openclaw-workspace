# Explorer Pane Controls (Hermes Parity) — Design

**Date:** 2026-06-11
**Reference:** [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui) @ `e8d71a2` (MIT),
local pinned clone `/tmp/hermes-webui` (re-clone if missing).
**Builds on:** `2026-06-10-hermes-ui-adoption-design.md` Phase 3 (Explorer v1, read-only).

## Goal

Bring the WORKSPACE explorer pane from read-only v1 up to (adapted) parity with
the real Hermes workspace panel:

1. File management: upload (button + OS drag-and-drop), new file, new folder,
   rename, move, delete, folder zip download
2. Hidden-files toggle behind a ⋯ prefs menu, with "hidden visible" indicator
3. Git badge upgrade: branch + dirty dot
4. Files / Artifacts tab pair (artifacts harvested from session tool events)
5. Panel resize handle; persisted tree expand state

## Decisions (user-confirmed)

- **Navigation model:** keep our full-tree (`<details>`-based, whole workspace
  in one cached payload). No per-directory loading, no breadcrumb/up-dir —
  Hermes's per-dir model is NOT adopted.
- **File ops UX:** Hermes-style right-click context menu, **plus a ~500ms
  long-press** opener for iOS (Safari never fires `contextmenu` on touch).
  Delete is **permanent** after a confirm dialog (no trash folder), matching
  Hermes. Skip Hermes's Reveal-in-Finder / Open-in-VS-Code items (server-side
  desktop actions, useless remotely).
- **Drag-to-move:** desktop-only HTML5 DnD like Hermes. iOS gets a "Move to…"
  context-menu item with a destination-path prompt instead. No touch drag.
- **Artifacts tab:** include now (not deferred), harvesting from the SSE tool
  frames the bridge already emits.
- **Approach:** C — extend `workspace-explorer.js` + `workspace_files.py` in
  place; lift self-contained Hermes helpers verbatim where fiddly (OS
  folder-drop directory walker, Finder-style stem-select rename). MIT license
  permits; keep an attribution comment at each lifted block.

## Backend — `backend/workspace_files.py` (extends in place)

The module drops its "read-only by construction" framing; the docstring is
updated accordingly.

### Write endpoints

All JSON `POST` unless noted. Every path goes through the existing
`resolve_safe`; every mutation invalidates the tree cache (`_cache`).

| Route | Body | Behavior |
|---|---|---|
| `/api/workspace/upload` | multipart `file[]` + `dir` | Writes into `dir`. Name collision → Finder-style ` (1)` suffix. Per-file cap 50MB → `413`. |
| `/api/workspace/create` | `{path}` | Creates empty file; `409` if exists. |
| `/api/workspace/mkdir` | `{path}` | Creates dir (parents ok); `409` if exists. |
| `/api/workspace/rename` | `{path, new_name}` | `new_name` is a bare name (no `/`); `409` if target exists. |
| `/api/workspace/move` | `{path, dest_dir}` | Moves file or dir into `dest_dir`; `409` if target exists. |
| `/api/workspace/delete` | `{path}` | File → unlink; dir → recursive delete. Refuses the workspace root itself. |
| `/api/workspace/archive` | GET `?path=` | Streams a zip of a dir ("Download folder"). Skips `SKIP_CONTENTS` entries; refuses past ~100MB uncompressed total → `413`. |

### Safety rails

Every mutation route refuses any path containing a `SKIP_CONTENTS` segment
(`.git`, `.versions`, `node_modules`, `__pycache__`, `.venv`) — the explorer
can never delete vault version history or repo internals, even past a confirm
dialog. This is a deliberate tightening over real Hermes.

### Read changes

- `/api/workspace/tree` gains `?hidden=1`: walks dot-directories (still
  excluding `SKIP_CONTENTS`) under the same `MAX_DEPTH` / `MAX_ENTRIES` /
  `MAX_PER_DIR` caps. Hidden and non-hidden variants cache under separate
  keys (same `CACHE_TTL`).
- Tree response gains `"dirty": bool` from `git status --porcelain`
  (same subprocess pattern, 5s timeout, failure → `false`; computed with the
  branch lookup, cached with the tree).

### Exposure note

These writes sit on :8800, wide-open on LAN behind Tailscale Serve — the same
trust model as the existing Documents-editor writes. No new auth introduced;
the surface grows from "edit doc-compatible files" to general file management.
Accepted consciously.

### Tests — `backend/tests/test_workspace_files.py`

Traversal attempts on every mutation route; `SKIP_CONTENTS` refusal; upload
collision suffixing; root-delete refusal; cache invalidation after mutation;
`hidden=1` walking (dot-dir contents appear, `SKIP_CONTENTS` still skipped);
archive size refusal.

### Deploy

Rides the already-pending workspace LaunchAgent restart. No extra restart.

## Frontend — `frontend-overrides/` only

Files touched: `js/workspace-explorer.js` (bulk), `hermes.css` (styles),
`index.html` (header buttons, tabs, file input), `js/chat.js` (one-line event
dispatch), `sw.js` (CACHE_NAME bump).

### Header controls

Existing refresh + collapse stay. Added, in Hermes `panel-icon-btn` style:

- **Upload** — hidden `<input type=file multiple>`; uploads target workspace
  root.
- **New file / New folder** — prompt dialog; created at root. (Per-folder
  creation lives in the dir context menu.) New file opens in the editor via
  existing `openInEditor` after creation.
- **⋯ prefs menu** — single item: "Show hidden files" toggle. Persisted in
  localStorage (`hermes-workspace-show-hidden`); toggling refetches the tree
  with `?hidden=1`. When on, the Hermes eye "hidden visible" indicator shows
  next to the pane title.
- **Git badge** — replaces the plain branch span: branch name + a dot when
  `dirty` is true.

### Tree rows

- **Persisted expand state** — localStorage set of open dir paths replaces
  the current `depth < 1` default-open rule.
- **Context menu** — right-click (desktop) or ~500ms long-press (iOS; timer
  cancelled on `touchmove` so it never fights scrolling — swipe-triage
  lesson). Items:
  - File: Open, Rename, Move to…, Copy path (absolute, from tree `root` +
    rel), Download, ─, Delete (red, confirm).
  - Dir: New file here, New folder here, Rename, Move to…, Download zip,
    ─, Delete (red; confirm names the folder and states it is recursive).
  - "Move to…" is the iOS-reachable move path (destination prompt); harmless
    duplication of drag-to-move on desktop.
- **Rename** — prompt dialog with Hermes Finder-style stem selection (lifted):
  selects basename, preserves extension; dirs/dotfiles select-all.
- **Drag-to-move** — desktop HTML5 DnD: rows `draggable`,
  `application/ws-path` + `application/ws-type` payload, drop highlight on
  dir rows, drop calls `/api/workspace/move`.
- **OS file drop** — Finder files dropped on a dir row upload there; on tree
  background upload to root. Folder drops use Hermes's
  directory-entry-reader helper (lifted).
- **Dialogs** — tiny self-contained prompt/confirm overlay inside the module
  (no shared dialog helper exists; native `prompt()` is unusable in the PWA).
  Confirm's destructive button is danger-styled with focus on Cancel.

### Files / Artifacts tabs

- Hermes-style tab pair under the header: `Files` | `Artifacts (n)`.
- `chat.js` dispatches a `workspace:toolframe` CustomEvent for each
  `tool_start` / `tool_output` SSE frame (detail = the parsed frame).
- The explorer listens, regex-harvests path-like tokens from `command` /
  `output` strings, normalizes, and **validates each candidate against the
  loaded tree** (a Set of known paths rebuilt on each tree load — no
  exists-endpoint). Dedupes; newest first; click opens via existing
  `openFile`. Cleared on session switch.
- Degradation: if gateway `meta`/`title` strings are path-poor, the tab is
  sparse but never wrong. After a mutation-suggesting frame, the explorer
  triggers a debounced `load(true)` so new files show up.

### Panel chrome

Left-edge resize handle (pointer events), clamped 200–600px, width persisted
in localStorage. Collapse/reopen behavior unchanged. Mobile drawer behavior
unchanged.

### Hygiene

- `sw.js` `CACHE_NAME` bump for release; **no `?v=` on module scripts**
  (double-load lesson).
- All frontend edits in `frontend-overrides/` (the only durable source);
  sync via `scripts/sync-frontend.sh`.
- Verification: `node --check`, backend pytest, curl byte checks, user
  eyeballs. **No headless Chrome on this machine.**

## Risks

| Risk | Mitigation |
|---|---|
| Long-press vs. scroll conflicts on iOS | cancel timer on `touchmove`; tune threshold on device |
| Artifact harvest quality depends on gateway detail strings | tree-validated candidates: sparse-but-correct degradation |
| Big uploads / zips strain the 2014 mini | 50MB upload cap, ~100MB archive refusal, existing tree caps |
| Write endpoints on LAN-open :8800 | unchanged trust model; SKIP_CONTENTS rail bounds blast radius |
| Pane module growth (~130 → ~500+ lines) | acceptable; split into `workspace-explorer-ops.js` only if it passes ~600 lines |

## Out of scope

Per-directory navigation/breadcrumbs, touch drag-to-move, trash-folder
deletes, inline preview-pane editing (our doc editor covers it), profile
pills, Reveal-in-Finder / VS Code menu items.
