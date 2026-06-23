# Activity Trail — Claude Cowork Parity (redesign)

**Date:** 2026-06-23
**Surface:** `frontend-overrides/js/redesign/` (the Direction A redesign SPA at `/static/index-redesign.html`)
**Status:** Design approved (brainstorm). Ready for implementation plan.

## Context

The redesign renders an "activity trail" under each assistant turn — a Cowork-style
list of thinking + tool steps. Three problems motivated this work; the first two are
already fixed, this spec covers the third:

1. *(fixed, commit e998479)* Reloaded chats dropped the trail — `fetchThread` ignored
   the `tool_events` metadata the backend now returns. It now reconstructs steps.
2. *(fixed, commit e998479)* A page refresh flashed `MOCK_CHAT_THREAD` sample content
   before real history loaded. Removed the mock fallback (desktop + mobile).
3. **This spec:** the reconstructed/live trail is a **wall** — every tool call is its own
   row with output expanded (e.g. 48 consecutive `bash` rows). It is not Cowork-level
   polish, and the live-streaming behavior needs to be verified and matched to it.

The renderer (`chat-activity.js` `renderActivity`) and the live pipeline
(`live/chat.js` `send()`/`onEvent` building `turn.activity` from `tool_start`/`tool_output`)
already exist; this is a rework of presentation + a grouping layer, not new plumbing.

## Goals

- A finished turn rests quietly and expands on demand (no wall).
- The same trail renders **live while streaming** and **on reload**, with one renderer.
- Consecutive same-tool runs collapse into a single group, order preserved.
- Match Claude Cowork's feel: compact rows, progressive disclosure, failures surfaced.

## Non-goals

- No backend transcript/format changes for the core work (reuses existing
  `_map_history` `tool_events` / `round_texts`).
- No change to the classic SPA.
- Thinking-on-reload is a **fast-follow**, not core (see "Fast-follow" below).

## Interaction model

**Three-level progressive disclosure.**

- **Level C — summary (resting/done default):** one line,
  `✓ Worked for {elapsed} · {aggregate}` (+ red `· N failed` when any step failed).
  Click → expands to B.
- **Level B — compact rows + groups:** one line per step (output hidden); consecutive
  same-tool runs shown as a single group line (`Ran 11 commands`). Click a group → its
  member rows; click a leaf row → A.
- **Level A — detail:** full output (monospace, colorized) or, for thinking, the
  reasoning text.

**Live (status `working`):** trail auto-**expanded**. Completed steps are compact ✓ rows
(grouped where consecutive same-tool). The **currently-running** step renders standalone
(never grouped until done) with its output streaming + a blinking cursor, under a
`Working… {elapsed}  ■ Stop` header.

**On finish (working → done):** the trail **auto-collapses** to the C summary. Falls out
naturally: `renderActivity` defaults `done` trails to collapsed.

**Grouping rule:** group a maximal run of **consecutive, completed** steps that share the
same `kind`. A single run is not grouped (renders as a normal row). The active/running
step terminates the current group and renders standalone.

## Visual / formatting spec

Reuse existing `ACT_ICONS` kinds and `toolKind()` mapping.

| kind | icon | color | verb (past) | live verb |
|------|------|-------|-------------|-----------|
| think | ✦ | violet | Thought for Ns | Thinking |
| read | ▤ | blue | Read | Reading |
| grep | ⊙ | gold | Searched | Searching |
| edit | ✎ | teal | Edited | Editing |
| run | › | green | Ran | Running |
| web | ◍ | blue | Searched the web | Searching the web |
| generic | ⚙ | faint | Ran tool | Working |

- **Row (B):** `icon · verb · target · result-meta`. `target` = file or command, truncated
  with ellipsis (CSS `max-width`, full text revealed at A). `result-meta` right-aligned:
  line count / match count / `142 passed` / `exit 1` (red on failure).
- **Group line:** `icon · "{verb} N {noun}"` (`Ran 11 commands`, `Read 3 files`,
  `Searched 4 times`) · aggregate meta. Any member failed → red **`N failed`**.
- **Summary (C):** `✓ Worked for {elapsed} · {aggregate}` where aggregate joins per-kind
  counts in first-seen order (`read 3 files, 1 search, 11 commands`). These are **turn
  totals per kind** — distinct from the *consecutive* groups shown when expanded (e.g. a
  turn with read, run×5, read, run×6 summarizes as `read 2 files, 11 commands` but expands
  to two separate run groups). Red `· N failed` appended if any failure. **On reload** there
  is no timing → drop `Worked for {elapsed} ·` and show the aggregate alone.
- **Errors:** failed leaf → ✗ + red `exit N`; bubbles to group (`N failed`) and summary.
- **Output (A):** dark monospace block, `lineColor()` per line (green success markers,
  red errors), `max-height ~220px` with scroll. Output already capped at 8k chars by the
  backend (`_tool_output`).

## Architecture

Keep units small and one-purpose.

### 1. `groupSteps(steps)` — pure grouping (new)
New function (in `chat-activity.js`, or a small `chat-activity-group.js` if it grows).
Input: `activity.steps` (the existing step array). Output: ordered render items:

```
item = { type: 'single', step }                       // one step
      | { type: 'group', kind, steps: [step, …], id }  // ≥2 consecutive same-kind, all done
```

Rules: walk steps in order; accumulate a run of consecutive completed steps with equal
`kind` (kind !== 'think' — thinking never groups); flush as a `group` when length ≥ 2,
else `single`; any `running` step flushes the current run and emits as `single`. Group
`id` is derived from the first member's id (stable for collapse state). Pure and unit
testable in isolation.

### 2. `renderActivity(m, s)` — rework (existing, `chat-activity.js`)
- Compute `items = groupSteps(act.steps)`.
- `working` status → render the `Working… {elapsed} · Stop` header + items, trail open.
- `done` status → render the **C summary** line (aggregate from `act.steps`), collapsed
  unless `s.chatUI.trail[m.id] === true`.
- Group item → a group line; expanded (`s.chatUI.group[item.id]`) → its member rows.
- Single/leaf row → existing `stepRow`; expanded (`s.chatUI.step[st.id]`) → `stepDetail`.
- Summary/aggregate helpers (`summarize(steps)` → `{elapsed?, parts[], failed}`) live
  next to `renderActivity`.

### 3. Collapse state — add a level
`s.chatUI` gains `group: { [groupId]: bool }` alongside the existing `trail` and `step`.
A new `toggleGroup` action mirrors `toggleTrail`/`toggleStep`; wire its `data-act` in the
redesign event delegation (`app.js`). Done-trail default flips from open to **collapsed**
(`renderActivity` returns collapsed unless explicitly toggled open).

### 4. Live pipeline (`live/chat.js`) — minimal
Already builds `turn.activity = { status, steps, startMs, elapsed }` via `newStep` on
`tool_start` and finalizes on `tool_output`. No structural change: `groupSteps` only groups
**completed** steps, so the running step always renders standalone. Auto-collapse is
achieved by the `done` default in `renderActivity` when the turn ends. Verify the existing
`throttledRender` cadence still feels live with grouping applied.

### 5. Reload pipeline (`live/chat.js` `fetchThread` / `historySteps`) — none
Already maps `tool_events` → steps (commit e998479). Same `renderActivity` + `groupSteps`
apply. Reloaded turns are `status:'done'` → collapsed by default.

### 6. Mobile (`mobile/mobile-surfaces.js` `mChatMsg`)
Shares `renderActivity` already; inherits grouping + collapse. Confirm `.m-thread` scaling
still reads well; no separate logic.

## Data shapes (reference, unchanged)

```
activity = { status:'working'|'done', elapsed?, worked?, startMs?, steps:[ step ] }
step = { id, kind, label, file?, meta?, metaColor?, state:'running'|'done'|'error',
         body?,           // thinking text (A)
         lines?:[{t,c}] } // output lines (A)
```

Backend `tool_events` (per saved turn, from `_map_history`):
`{ round, tool, command, output, exit_code }` (+ `round_texts[]` for the answer text).

## Edge cases

- **Single run** of a kind → normal row, not a group.
- **All steps one kind** (the 48-bash case) → one group `Ran 48 commands`, expandable.
- **Failure inside a group** → group shows `N failed` (red); expanding reveals the ✗ leaf
  + its red output; summary shows `· N failed`.
- **Tools with images/screenshots** (browser): out of scope here — `_map_history` extracts
  text output only today. Leaf renders available text; image rendering is future work.
- **`message` reply-delivery tool**: already filtered from reconstruction (parity with the
  live relay that hides its card). Keep filtered.
- **Empty turn** (no steps): `renderActivity` returns `''` (unchanged); the empty-turn
  safeguard notice handles "no response".

## Reload scope boundaries (live is unaffected)

1. **No per-step timing** — saved `tool_events` carry no durations. Reloaded summaries omit
   `Worked for Xs` and per-step `Thought for Ns`; live keeps them (`startMs`/`elapsed`).
2. **No thinking steps on reload** — reasoning isn't in `tool_events`. Live shows thinking;
   reload shows tool steps + final text. See fast-follow.

## Fast-follow (after this work ships): thinking on reload

Goal: reloaded turns also show `✦ Thought…` steps (expandable to the reasoning), matching
live. Sketch:

- **Backend** (`backend/bridge.py` `_map_history`): the brain transcript carries reasoning
  as analysis/`thinking` content separate from `toolCall` blocks. Capture it into the
  turn metadata as `thinking: [{ round, text }]` (or fold into a unified ordered
  `activity` list), respecting the existing 8k-ish cap. Add unit coverage in
  `test_bridge.py` mirroring the live analysis shape.
- **Frontend** (`historySteps` in `live/chat.js`): emit `{ kind:'think', state:'done',
  body:text }` steps interleaved at their round position so `groupSteps`/`renderActivity`
  render them unchanged.
- Boundary: still no per-step *timing* on reload (label is `Thought` without `for Ns`).

This is intentionally deferred so the core grouping/collapse/live work lands first.

## Verification

- **Unit:** `groupSteps` — consecutive grouping, single-not-grouped, running-stays-single,
  failure flagging, all-one-kind. (`summarize` aggregate + failed count.)
- **Reload (headless Chromium):** open the 48-`bash` session → summary collapsed by
  default; expand → one `Ran 48 commands` group; expand group → leaves; expand a leaf →
  output; a known-failed command shows ✗/red bubbling to group + summary.
- **Live (headless):** drive a multi-tool turn (when Gary invokes tools) → trail expanded,
  running step streams standalone, completed runs group, and on finish the trail
  auto-collapses to the summary.
- **No regressions:** existing redesign chat tests / backend suite stay green.
