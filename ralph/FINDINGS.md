# Findings — parity gaps & wiring issues

Append-only. One bullet per issue: `file:line` + the fix made, or `deferred — needs human: <what decision is missing>`.
Note in a bullet if a fix also requires Frank to re-run `scripts/sync-frontend.sh` (audit target is `frontend/`, deployed copy is `frontend-overrides/`).

- **The entire redesigned Settings surface is non-interactive — every action button is dead.** None of the buttons rendered by `frontend/js/redesign/surfaces.js` for settings cards carry a `data-act` (or any class-based click handler — grep of `frontend/js/redesign/` finds none). Affected, all in surfaces.js:
    - `set-launcher` (surfaces.js:479) — **"Open Brain"** (settings-data.js:106), **"Open Scheduled jobs"** (:107), **"Open theme picker"** (:109).
    - `set-btn` via `btns()` (surfaces.js:441) — **"Export Data" / "Import Data"** (Data Backup, settings-data.js:143), plus any other `btns([...])` rows.
    - `set-btn danger` "Wipe" (surfaces.js:455) — every Danger-Zone **"Wipe …"** button (settings-data.js:144–147: wipe memory/skills/all).
  - Discovered while auditing the old memory-modal cluster (close/tabs/IO/skills, index.html:377–509): those features are intentionally relocated into Settings cards, but the cards can't actually *do* anything yet.
  - `deferred — needs human:` this is a build-out, not a one-line wiring fix. (a) The launchers have no target surface (no Brain/Scheduled/theme-picker surface exists). (b) Export/Import Data + Wipe buttons need real backend calls (and Wipe needs a confirm guard — destructive). Decide per button: build the target surface/modal, add a `data-act` + an `actions[...]` handler, and the backend endpoint. Likely >50 lines / multiple files → out of scope for a single audit iteration.
  - When fixed in `frontend-overrides/`, Frank must re-run `scripts/sync-frontend.sh` to deploy.

- **Search is decorative across the whole redesign — no search/filter works.** Every search affordance in `frontend/js/redesign/surfaces.js` is a static `<div class="oc-search">` containing only an icon + a placeholder `<span class="ph">` (and sometimes a `⌘K` `<span class="kbd">`). There is **no `<input>`, no `data-act`, no click handler, and no ⌘K/Ctrl-K keyboard handler** anywhere in `frontend/js/redesign/` (grep for metaKey/ctrlKey/`'k'`/openSearch = empty). Affected:
    - Chat conversation filter "Filter conversations… ⌘K" (surfaces.js:23).
    - Inbox "Search · INBOX" (surfaces.js:123).
    - Library "Filter library…" (surfaces.js:343).
    - Notes "Search notes…" (surfaces.js:381).
  - Old design had real search: `rail-search-btn` (index.html:825, "Search conversations (Ctrl+K)") backed by `frontend/js/search.js` + `search-chat.js`, plus a global Ctrl+K (keyboard-shortcuts.js).
  - `deferred — needs human:` decide the model per bar — in-place client filter of the already-loaded list (cheap, ~per-surface) vs. a global command-palette/search surface like the old Ctrl+K (bigger). Then convert each `oc-search` div to an input bound to a `data-model` state field + filter the rendered list, and (if keeping ⌘K) add a global keydown handler in app.js. Multi-surface; >50 lines. Fix in `frontend-overrides/` then re-run `scripts/sync-frontend.sh`.
