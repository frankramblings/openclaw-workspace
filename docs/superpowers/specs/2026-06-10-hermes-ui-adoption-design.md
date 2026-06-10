# Hermes UI Adoption — Design

**Date:** 2026-06-10
**Status:** Approved scope, pending spec review
**Reference:** [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui) @ `e8d71a2` (MIT).
Local reference clone used during design: `/tmp/hermes-webui` (re-clone and pin
this commit at implementation time; do NOT vendor their files — we adapt values
into our own CSS/JS and credit in `frontend-vendor/THIRD-PARTY.md`).

## Goal

Adopt the Hermes WebUI visual style across the openclaw-workspace SPA:

1. Hermes color themes + sans-UI/mono-code typography + component skin (every theme)
2. Full Hermes sidebar layout (icon strip on top, date-grouped history, footer model block)
3. New right-hand WORKSPACE file explorer pane (read-only v1, browse + open)
4. Chat fidelity pass (avatar circles, tool accordion pills, capsule input)

Decisions made with the user:

- **Scope:** full adoption (all four tiers), phased so each ships independently.
- **Theming:** additive — 4 new Hermes presets in the existing engine; **Hermes
  Charcoal becomes the default for fresh installs**; saved themes untouched;
  legacy presets, custom themes, patterns/effects all remain.
- **Explorer v1:** browse + open only. No upload/delete/rename. Manual refresh.
- **Sidebar:** full Hermes layout — the vertical icon rail dissolves into a
  horizontal icon strip at the top of the sidebar. Hermes "profile tag" pills
  are **skipped** (no OpenClaw counterpart).

## Non-goals

- No adoption of the Hermes frontend codebase or its theme×skin engine — we map
  values onto our existing `THEMES` + advanced-vars system.
- No file CRUD in the explorer (v2 candidate: upload).
- No new token-usage plumbing: the per-message usage line ships only if the
  gateway already emits usage in events we receive (verify at implementation).
- No changes to mobile drawer behavior beyond restyling; explorer pane is
  desktop-only (hidden < ~1100px).
- No per-phase LaunchAgent restarts (2014-mini constraint) — one activation at
  the end.

## Architecture

All durable frontend work goes in `frontend-overrides/` (the only durable
frontend source — `frontend/` is build output, upstream Odysseus is gone),
baked by `scripts/sync-frontend.sh`. One new backend module. Hermes CSS values
are **copied/adapted, never imported at runtime**.

| File | Status | Role |
|---|---|---|
| `frontend-overrides/hermes.css` | NEW | Structural component skin, loaded after `workspace.css` (same `<link>` injection mechanism in sync script AND in `frontend-overrides/index.html` — both places, per the injector-loss lesson) |
| `frontend-overrides/js/theme.js` | existing override | +4 presets, new default, sans default font |
| `frontend-overrides/js/sessions.js` | existing override | date-group rendering of the session list |
| `frontend-overrides/index.html` | existing override | sidebar DOM restructure, explorer pane skeleton, new script tags |
| `frontend-overrides/js/workspace-explorer.js` | NEW | explorer pane module (self-contained overlay, pattern: `cron.js`) |
| `frontend-overrides/workspace.css` | existing | untouched except where sidebar rules conflict; sidebar-specific rules migrate into `hermes.css` |
| `backend/workspace_files.py` | NEW | read-only tree + file endpoints |
| `backend/app.py` | existing | register new router before catch-all |

Public-product rules apply throughout: `__AGENT_NAME__` token for visible text,
no personal values in code (workspace root comes from config, not a hardcoded
path), neutral defaults.

## Phase 1 — Tokens, themes, typography (pure skin)

### 1a. Theme presets (`theme.js`)

Four entries added to `THEMES`, each with an `advanced` block (the engine
already supports `sidebarBg`, `inputBg`, `inputBorder`, `userBubbleBg`,
`aiBubbleBg`, `bubbleBorder`, `codeBg`, `codeFg`, `sendBtnBg`, `sendBtnHover`,
`accentPrimary`, `accentError`, `toggleBg`, `toggleActive`, `sectionAccent`,
`brandColor`).

Starting values (implementation verifies/refines against the pinned Hermes
`static/style.css` and the four user-supplied screenshots; the screenshots win
where they differ):

| Preset key | bg | panel/sidebar | fg | border | accent (`red`) | Source |
|---|---|---|---|---|---|---|
| `hermesCharcoal` (new default) | `#1E1F22` | `#17181B` | `#D7DAE0` | `#33353A` | `red`=`#E8C268` gold; `--color-accent` stays blue `#4DD0E1` | screenshot 1 surfaces + Hermes gold family |
| `hermesLight` | `#FEFCF7` | `#FAF7F0` | `#1A1610` | `#E0D8C8` | `#B8860B` | Hermes `:root` light, screenshot 2 |
| `hermesSolarizedDark` | `#0A252E` | `#08303A` | `#9CC7C2` | `#1B4651` | `red`=`#6FD3A6` mint; `accentError`=`#EF5350` coral | screenshot 3/4 |
| `hermesNavy` | `#10141F` indigo | `#141A2A` | `#E8EAF2` | `#27304A` | gold `#FFD700` (pinned items) | screenshot 3 (deep navy variant) |

- `DEFAULT_THEME` → `hermesCharcoal`. Existing users keep their saved
  localStorage theme; only fresh installs see the new default.
- Each preset also sets sensible `--hl-*` syntax colors (lift from the nearest
  existing preset; midnight for Charcoal/Navy, light for Light).
- No background pattern/effect defaults for the new presets (`'none'`).

### 1b. Typography

- `DEFAULT_FONT` flips `mono` → `sans` in `theme.js` (FONT_MAP already has the
  sans stack). Existing users with a saved font keep it.
- `hermes.css` pins the mono stack (`'Fira Code', monospace` — already
  self-hosted) on: `pre, code, .hljs`, tool-card command/path/JSON text,
  explorer file sizes and paths, the footer workspace-path line, token-usage
  lines. UI chrome stays sans.
- Base UI size ~14px, chat body ~14.5px/1.6–1.7 line-height (Hermes values).

### 1c. Component skin (`hermes.css`, applies in every theme)

Written entirely against theme variables (`var(--bg)`, `var(--panel)`,
`var(--red)`, advanced vars) so all themes — legacy included — get the Hermes
structure without color assumptions:

- 1px solid pane dividers; dense 8–16px padding rhythm.
- Buttons/chips → rounded pills; primary actions filled with accent, secondary
  ghost/outline.
- Message input → floating capsule bar: attachment + (existing) voice icons on
  the left, existing session/model selectors restyled as dropdown chips,
  circular accent-filled ↑ send button on the right.
- Modals (settings, theme picker, etc.): uppercase letter-spaced field labels,
  thick-bordered inputs/selects, square custom checkboxes (accent fill +
  white check when on), full-width block primary button at the bottom.
- Thin (6–8px) scrollbars using border/panel tones (replacing the accent-red
  thumb).
- Status dots: small filled/hollow circles using `--green` / `--color-accent` /
  `--warn` semantics (sidebar already has a notif-dot concept; restyle it).
- Tool cards (see Phase 4 for behavior): collapsed pill look defined here.

**Acceptance (Phase 1):** theme picker shows 4 new swatches; fresh profile
(clean localStorage) boots into Charcoal + sans; code blocks and tool cards
render mono; legacy themes still render correctly with the new component
shapes; no regression in custom-theme editor.

## Phase 2 — Sidebar restructure

DOM changes in `frontend-overrides/index.html`, rendering changes in
`sessions.js`, layout/skin in `hermes.css`.

### 2a. Icon strip

- The `.icon-rail` buttons (search, new chat, chats, documents, calendar,
  email, inbox, notes, cron, memories, compare, cookbook, settings, theme, …)
  **move into a horizontal flex-wrap strip at the top of `#sidebar`** (2 rows
  expected at current count). Buttons keep their existing IDs, click handlers,
  titles, and notification-dot children — they are relocated, not rewritten.
- The old vertical rail container is hidden via CSS (not deleted from the DOM)
  so `sidebar-layout.js` references stay valid; its resize handle and
  "rail-minimized" mode are disabled in Hermes layout. **Fallback switch:** a
  single CSS class on `<body>` (`hermes-rail-fallback`) restores the vertical
  rail if the strip breaks something — documented in the code.
- Mobile (<768px): unchanged drawer behavior; the strip renders inside the
  drawer.

### 2b. Sidebar content

Top→bottom: icon strip · `+ New conversation` full-width pill with `Ctrl+K`
ghost hotkey hint (wires to existing new-chat + existing Ctrl+K binding) ·
`Filter conversations…` rounded input (wires to the existing search/filter
path in `search.js`/`sessions.js`, filtering the list in place) · grouped
session list · footer block.

### 2c. Date grouping (`sessions.js`)

- New render mode (becomes the default; existing folder/manual sort modes stay
  selectable): muted uppercase group headers `★ PINNED`, `TODAY`, `YESTERDAY`,
  `THIS WEEK`, `LAST WEEK`, `EARLIER`, computed client-side from the session
  timestamps already present. Starred sessions = PINNED.
- Empty groups are omitted. Row styling: full-width hover block, accent
  left-edge or tinted background for the active session, trailing status dot
  for sessions with a live stream (sessions.js already tracks streaming
  spinners — reuse that signal).

### 2d. Footer block

Glued to sidebar bottom (Hermes "granular developer console" variant):

- Active-model dropdown — relocates/restyles the existing model picker
  trigger; selection behavior unchanged (per-web-session `modelOverride`).
- Muted mono workspace path line (from `/api/config` / capabilities — display
  only).
- Small action row: `↑ Transcript`, `</> JSON`, `↑ Import` mapped to the
  existing export/import functions where they exist; any without an existing
  function is omitted (no new export plumbing in this project).

**Acceptance (Phase 2):** all former rail destinations reachable from the
strip (count parity, notification dots intact); date groups correct around
midnight boundaries (computed from local time); filter narrows the list;
model picker still sets the session override; mobile drawer unaffected;
fallback class restores the rail.

## Phase 3 — WORKSPACE explorer (new feature)

### 3a. Backend (`backend/workspace_files.py`)

Root = the OpenClaw agent workspace directory, resolved from existing config
(same source the backend already uses for vault/notes paths — i.e.
`~/.openclaw/workspace` on the maintainer's box, never hardcoded).

- `GET /api/workspace/tree` →
  `{root: str, branch: str|null, tree: [{name, path, type: "dir"|"file", size, children?}]}`
  - `path` is root-relative; sizes in bytes (frontend formats `4.2k`).
  - Depth cap (~6) and entry cap (~2000) with a `truncated: true` marker.
  - `.git` appears as a (childless) entry; its contents are never walked.
    Skip-list for contents: `.git`, `node_modules`, `__pycache__`, `.venv`.
  - `branch` from `git -C <root> rev-parse --abbrev-ref HEAD` (null on
    non-repo / error; never raises).
  - In-process cache ~10s (2014-mini-friendly; refresh is manual anyway).
- `GET /api/workspace/file?path=<rel>` →
  - Traversal guard: `resolve()` result must be inside resolved root, else 400.
    Symlinks pointing outside root are rejected by the same check.
  - Text/markdown/json/code (by extension allowlist) inline with correct
    content-type, size-capped (~512 KB) with a clear "truncated" response
    header; images inline; everything else `Content-Disposition: attachment`.
- Read-only by construction — module registers only GET routes. Registered in
  `app.py` before the catch-all.
- Errors: missing root → `{tree: [], branch: null, missing: true}` (frontend
  shows an empty state, not an error toast).

### 3b. Frontend (`workspace-explorer.js` + `hermes.css` + `index.html`)

- Fixed-flex right pane (~22%, min 220px), grid column added to the main
  layout; collapsible via a `Files`-style toggle in the chat header; collapsed
  state in localStorage; hidden entirely on mobile/narrow (<1100px) and on
  non-chat tabs (calendar, email, etc. keep full width).
- Header: `WORKSPACE` label + branch badge + `⟳` refresh.
- Tree: indentation per level, chevron expand/collapse for dirs (children
  rendered lazily from the already-delivered tree), mono filenames, muted
  right-aligned sizes with dotted leaders.
- Click file → preview modal (reuses existing modal + markdown renderer for
  .md; `<img>` for images; `<pre>` for text) with a Download link to the same
  endpoint.

**Acceptance (Phase 3):** pytest — tree mapper (sizes, skip-list, caps),
traversal rejection (`../`, absolute, symlink-out), branch fallback; UI — tree
renders real workspace, refresh works, preview/download work, pane collapses
and stays collapsed across reloads, layout intact with pane hidden.

## Phase 4 — Chat fidelity pass

Mostly CSS on existing structure; small `chat.js` touches:

- Avatar circles: colored initial discs (user = "Y"-style letter, agent =
  first letter of `__AGENT_NAME__`/branding) on each message row.
- Tool accordions: existing tool cards restyled as full-width bordered pills —
  `▶ tool <one-line truncated command/path/JSON>` collapsed, chevron expands
  to the raw output (expand/collapse behavior already exists in `chat.js`;
  this is presentation only).
- Token-usage line (`585.3k in • 1.5k out`, muted mono, after agent
  messages): **conditional** — implement only if usage figures are already
  present in the gateway events the bridge forwards; verify first; if absent,
  drop the item (no new plumbing).
- Attachment log line styling (`[Attached files: …]`) for messages with
  uploads.
- Conversation header: title + `* N messages` badge + right-aligned pill
  chips (existing session/model/clear/files controls restyled).

**Acceptance (Phase 4):** visual parity check against the four reference
screenshots in all 4 Hermes themes; tool expand/collapse, streaming, stop
button, image send/receive, emoji proxy all still work (these live in
`chat.js`, the most load-bearing override — re-smoke after edits).

## Testing & rollout

- **Backend:** pytest for `workspace_files` (pure mappers + guards), run with
  the existing suite (195+ green stays green).
- **Frontend:** per-phase build to a scratch dir via `WORKSPACE_BUILD_DEST` +
  served locally for screenshot smoke before touching `frontend/`; final
  visual pass on desktop + iOS Safari (drawer, pane hidden).
- **Phasing/commits:** each phase is its own commit batch on `main`; phases
  are independently revertible; `hermes.css` is additive so Phase 1 can ship
  alone.
- **Live activation:** ONE `scripts/sync-frontend.sh` + LaunchAgent restart at
  the very end (budget 2–5 min cold start; don't restart per phase, don't
  retry-restart).
- **Public repo:** no personal identifiers; THIRD-PARTY.md gains a Hermes
  attribution entry (MIT, commit `e8d71a2`).

## Risks

| Risk | Mitigation |
|---|---|
| Sidebar rebuild breaks rail logic (resize/minimize/notif dots, `sidebar-layout.js`) | Riskiest piece isolated in Phase 2; buttons moved not rewritten; hidden-not-deleted rail + `hermes-rail-fallback` body class as escape hatch |
| `chat.js`/`sessions.js`/`theme.js` are full-file overrides — merge debt grows | Confined edits, clear `// HERMES:` markers around new blocks |
| Old themes look broken under new component shapes | Skin written 100% against vars; smoke 3–4 legacy themes in Phase 1 acceptance |
| Explorer tree on a big workspace slows the 2014 mini | Depth/entry caps, 10s cache, manual refresh, no watchers |
| Path traversal / serving files outside workspace | Single resolve-inside-root guard, symlink-aware, pytest-covered |
| Token-usage line has no data source | Conditional feature; verified before building, dropped if absent |

## v2 candidates (explicitly deferred)

Explorer upload + delete; profile-tag pills if a profile concept ever lands;
Hermes theme×skin (mode/accent split) engine; per-message usage if the gateway
grows usage events later.
