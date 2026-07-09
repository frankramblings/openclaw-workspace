# Chat Strip — sticky live-checklist above the composer

## Status: parked 2026-07-09 — implementation complete, live verification pending

Audit against the code (2026-07-09): Phases 0–6 are all implemented and shipped —
reducer + state (`redesign/chat-strip.js`, 347 lines), rendering wired into
`redesign/live/chat.js`, desktop CSS (`css/chat-strip.css`) linked in
`index.html`, mobile CSS in `mobile.css:806-817`, localStorage collapse
persistence, plan-preview dismiss, and 325 lines of passing reducer tests.
The stop-agent overflow item was a no-op stub for v1 and was not built.
**Resume point:** the Phase 6 live `/verify` walkthrough — trigger a TodoWrite
in a real session, watch the strip populate/tick/auto-clear, on desktop and
mobile PWA.

**Goal:** surface multi-step assistant activity (TodoWrite checklists, ExitPlanMode plan previews, background-agent progress) in a dedicated sticky+collapsible strip above the composer. Not another copy of the per-message activity trail — a single always-live view of what's happening *now*.

## Scope

**In:**
- TodoWrite: live checklist with pending → in_progress → completed icons; dedupes across a turn (updates, doesn't stack).
- ExitPlanMode: rendered markdown plan preview.
- Background agents (`Task`, `sessions_spawn`, `Agent` in Claude Code): one row per running agent, label · elapsed · state.
- Sticky above composer, desktop + mobile; hides entirely when nothing is live.
- Collapsed by default after user toggle (per-session localStorage); expanded on first appearance of a new source.

**Out (v1):**
- Cross-chat visibility (only shows for currently-viewed chat).
- Interactive Stop / dismiss buttons (visible, non-functional).
- Reorder / pin sources.
- Sound / desktop notifications.

## Approach

Standalone reactive component (`redesign/chat-strip.js`), rendered from `app.js` main render, reads a new `s.chatStrip` sub-state populated by the same SSE stream that feeds `chat-activity.js`.

## Phases

### Phase 0 — preserve raw tool inputs in the step model *(prerequisite)*
Currently `live/chat.js` `tool_start` grabs only `ev.command || ev.file || ev.path || ev.tool` as the step file field. The todos array (TodoWrite `input.todos`) and plan markdown (ExitPlanMode `input.plan`) are discarded before the frontend sees them.

- In `live/chat.js` `tool_start` handler: when `ev.tool` is `TodoWrite`, `ExitPlanMode`, `Task`, or `sessions_spawn`, stash `ev.input` on `st.payload`.
- Emit updates on subsequent `tool_input_delta` frames if backend sends them (check first — TodoWrite fires multiple times per turn; each call replaces the list).
- Backend check: confirm `tool_start` frames include `input`. If not, backend patch needed (~5 lines in the SSE serializer).

### Phase 1 — chat-strip state + reducer
- New `s.chatStrip = { todos, plan, agents, collapsed }` shape (see design §3).
- Reducer in `live/chat.js` classifies tool events after step creation: TodoWrite → replace `s.chatStrip.todos`; ExitPlanMode → set `s.chatStrip.plan`; Task/sessions_spawn → add to `agents` map; matching `tool_result` → mark done, auto-clear after 5s.
- Clearing rules: todos clear on turn-end iff all `completed`; plan clears on next user message; agents self-clear on completion.

### Phase 2 — rendering
- `redesign/chat-strip.js`: pure render function `renderChatStrip(s) → HTML`, returns empty string when all sources null.
- Collapsed pill row (~28px): chevron · per-source summary pills · overflow menu.
- Expanded panel (max 40vh, internal scroll): todos checklist reusing `ACT_ICONS` language, plan markdown via existing `markdown.js`, agent rows.
- `app.js` inserts one `renderChatStrip(s)` call in the chat pane render, above `.composer`.

### Phase 3 — desktop CSS
- `frontend-overrides/css/chat-strip.css`: `position: sticky; bottom: 0`, backdrop-blur, uses existing `--panel`/`--faint` design tokens.
- Collapsed transition (opacity + translateY).

### Phase 4 — mobile CSS
- Additions to `mobile.css` for `.m-strip`: sits above composer, below scroll area, above the fixed tab bar. Respects the fixed padding from `workspace-pwa-ios-inset-tabbar.md` (no `env(safe-area-inset-bottom)`).

### Phase 5 — persistence & polish
- `s.chatStrip.collapsed` persists to `localStorage.chatStripCollapsed`.
- Expansion resets to true when a new source appears while collapsed.
- Overflow menu wired to dismiss plan (sets `plan.dismissed=true`), stop-agent stub (no-op for v1, logs intent).

### Phase 6 — tests
- `frontend-overrides/js/__tests__/chat-strip.test.js`: reducer cases per tool, dedupe, agent auto-clear timing, collapse persistence.
- Live `/verify`: trigger TodoWrite in this session (like the one that motivated the ticket), watch it appear, tick items, hide when done.

## Files

**New:**
- `frontend-overrides/js/redesign/chat-strip.js`
- `frontend-overrides/css/chat-strip.css`
- `frontend-overrides/js/__tests__/chat-strip.test.js`

**Modified:**
- `frontend-overrides/js/redesign/app.js` — one render call + state init.
- `frontend-overrides/js/redesign/live/chat.js` — Phase 0 payload preservation + Phase 1 reducer.
- `frontend-overrides/css/mobile.css` — `.m-strip` additions.
- Possibly backend SSE serializer if `input` isn't in `tool_start` frames (TBD after Phase 0 audit).

## Deploy

`scripts/sync-frontend.sh` regenerates the served bundle; `systemctl --user restart openclaw-workspace.service`; PWA has controllerchange reload so refresh once and Frank sees it live.

## Risk / unknowns

1. **Backend `input` payload availability** — Phase 0 first task is `grep -n "input\|tool_start\|serialize" src/gateway/**` to confirm. If missing, small backend patch adds it.
2. **Background-agent event naming** — `Task` vs `sessions_spawn` vs `Agent` may all be used depending on model harness. Reducer needs to accept all three.
3. **Mobile height budget** — 40vh expanded panel on a small phone can hide 30% of the composer. May need to cap at 30vh mobile.
