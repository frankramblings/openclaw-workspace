# Inbox: restore classic features + Obsidian→Asana capture

**Date:** 2026-06-25
**Status:** Approved (design)
**Repo:** `/home/frank/openclaw-workspace`

## Problem

The current Inbox surface is a skeleton. `frontend/js/redesign/live/inbox.js` knows
only two verbs — `dismiss` and `triageAll` — and every button on every card
(primary, secondary, Archive, Keep, the ✕) funnels into `dismiss`. There is no
click-out, no read-in-place, no snooze, no undo/history, no Obsidian source, and
the source filter chips are static decoration.

A previous, fully-featured "classic" inbox (`frontend/js/inbox.js`, ~1076 lines,
loaded only by `index-classic.html`) had all of this, and **its backend is still
live** — `backend/inbox/` exposes every endpoint the classic UI used. So the port
is almost entirely a frontend job against an existing, tested API.

Separately, the Obsidian default action ("Reviewed") only locally hides an item.
Frank wants the Obsidian default to instead **capture the surfaced commitment as a
task in his personal Asana board** with a smart, context-derived due date — closing
the loop Granola → Obsidian (preservation) → Inbox (triage) → Asana (follow-up).

## Goals

1. Restore classic inbox functionality into the **current** redesign shell (keep the
   current card aesthetic and the NEEDS YOU / AI-SUGGESTED·FYI grouping).
2. Make every action real and per-source; add click-out, read-in-place, snooze,
   undo+history, working source filters (incl. Obsidian), AI rec chips, Hand-to-Gary,
   and mobile swipe triage.
3. Add a new **Add to Asana** action that creates a real task from a surfaced item,
   with a smart due date computed during the AI-triage pass, and make it the Obsidian
   default.

## Non-goals

- No write-back to Obsidian notes (no checking off `- [ ]`). "Dismiss" stays a local
  hide; we are not editing the vault.
- No visual redesign / revert to the classic look. Functionality only.
- No new auth: Gmail (himalaya), Slack (keychain), Asana (PAT) are already wired.

## Actual starting state (discovered)

A prior session already did part of this in the **canonical** `frontend-overrides/`
layer (the live `frontend/` is generated/stale, which is why the deployed inbox
looks like a skeleton). What exists:

- `live/inbox-logic.js` — pure, **unit-tested** helpers: `srcStyle`, `actionLabel`,
  `cardActions(item)`, `filterVisible(items,{dismissed,filter})`,
  `sourceCounts(items,opts,backendSources)`, `openUrlFor(item)`. Test:
  `node scripts/test/inbox-logic.test.mjs`.
- `live/inbox.js` — `load()` (maps feed incl. `actions[]`, `rec`, `meta`, all 5
  sources, `sources`/`errors`); actions `archive/delete/mark_read/complete/reviewed`
  (→ `runAction`), tolerant `dismiss`, `open` (click-out + gmail msgid resolve),
  `setFilter`. `dismissed` ids are **strings** here. `triageAll` is a placeholder
  (bulk-dismiss, not real triage). Captures `_lastUndoTs` but nothing consumes it.

What's **not** wired: the render layer. `inboxSurface()` (`surfaces.js`) and
`mInbox()` (`mobile-surfaces.js`) still hardcode `data-act="dismiss"` on every
button and ignore `cardActions`/`filterVisible`/`sourceCounts`/`inboxFilter`. So the
logic is reachable in code but from no rendered control. Genuinely missing:
read-in-place reader, snooze, undo toast + history, real triage, Hand-to-Gary,
tappable rec chip, working/extended filter chips, mobile right-swipe, and all of
Add-to-Asana (frontend + backend). There is no `package.json`; JS tests are
self-executing `.mjs` run with `node <file>`. Build deploy: edit
`frontend-overrides/`, run `scripts/sync-frontend.sh`, then restart the service.

The leftover numeric mock `dismiss` in `app.js` and `Number(d.id)` in the mobile
gesture can desync `state.dismissed` (string vs number) — fix as part of the rewire.

## Architecture fit

The shell (`app.js`) rebuilds `root.innerHTML` wholesale on every `render()` and
dispatches through `data-act` / `data-arg` event delegation. Therefore **all new UI
is state-driven** — nothing imperative that a re-render would wipe:

- Reader, snooze menu, undo toast, history drawer, and active filter all live in
  `state` and render as part of the surface (or a state-driven overlay).
- Live modules read/write `runtime.state` and call `runtime.render()` after async
  work, exactly as the chat module does.
- `live/index.js#loadSurface` merges a live module's exported `actions` over the
  shell's mock actions (this is how `inbox.js` already overrides `dismiss`/`triageAll`).

### Files

| File | Change |
|------|--------|
| `frontend/js/redesign/live/inbox.js` | Data + actions: load feed, per-source actions, snooze, undo, history, spinoff, addAsana, filter. |
| `frontend/js/redesign/live/inbox-detail.js` | **New.** Read-in-place reader: fetch + shape Gmail/Slack/Asana detail. Keeps `inbox.js` focused. |
| `frontend/js/redesign/surfaces.js` → `inboxSurface()` | Desktop render: real action rows, filter chips, reader overlay, snooze menu, toast, history drawer. |
| `frontend/js/redesign/mobile/mobile-surfaces.js`, `mobile-app.js` | Mobile render + extend existing swipe engine (right=primary, left=snooze\|dismiss) and reader bottom-sheet. |
| `frontend/css/redesign.css`, `mobile/mobile.css` | Styles for action rows, reader, snooze menu, toast, history, rec chip. |
| `backend/inbox/sources/asana.py` | **New** `create_task(name, notes, due_ms)` + `delete_task(gid)` (undo). |
| `backend/inbox/settings.py` | **New** `asana_section_gid()` (env > inbox.json > lookup "Backlog"). |
| `backend/inbox/__init__.py` | New action branch `add_asana` (any source) → create task, dismiss item, undo=delete. |
| `backend/inbox/recommend.py` | Triage prompt/parse extended so Obsidian items also return `task` + `due` suggestion cached on the rec. |

Both `frontend/` and `frontend-overrides/` are deploy layers; changes land in
**both** (build/sync mirrors them) — confirm during planning which is canonical and
keep them in sync.

## Backend: Add-to-Asana

### Endpoint contract (extends existing `POST /api/items/action`)

```
{ source, id, action: "add_asana", title, meta, task?, due? }
```

- `task` (optional): cleaned task name; falls back to `title`.
- `due` (optional): epoch-ms or ISO date; the triage pass supplies this. If absent,
  no due date is set (task still created).
- On success: create the Asana task, then `state.dismiss(source, id, "added_to_asana")`
  so it leaves the feed; return `{ok, undoTs}`.
- `undo = {"asana_delete_gid": <new task gid>}` → undo deletes the created task and
  un-dismisses the item.

### Asana task shape

- Project: `asana_project_gid()` (Frank To-Dos).
- Section: `asana_section_gid()` → **Backlog**. New setting; if unset, look up via
  `GET /projects/{gid}/sections`, match name "Backlog", cache. Created via
  `memberships: [{project, section}]` (or create-then-`addProject` with `insert`).
- `name`: `task` or `title`.
- `notes`: context block — source label, meeting-note title + date, the surrounding
  snippet, and a deep link back (`meta.url`, e.g. `obsidian://...`). Format:
  `Captured from <note> (<date>)\n\n<snippet>\n\nSource: <url>`.
- `due_on`: date from `due` (date-only; Asana `due_on` is a calendar date).

### Smart due date (computed in triage, not on tap)

Extend `recommend.build_triage_prompt`: for `obsidian` items, ask the model to also
return `task` (cleaned imperative name, ≤12 words) and `due` (ISO date `YYYY-MM-DD`
or `null`). Rules baked into the prompt:

- Honor explicit dates in the line/context ("by Friday", "EOM", "next week",
  absolute dates) relative to the note's date / today.
- If a referenced event date is known in context, use it; else pick a sensible
  default (e.g. **+3 business days**) so nothing is dateless-and-forgotten.
- `parse_triage_reply` validates and stores `task`/`due` on the rec for obsidian
  items (alongside `action`/`confidence`/`reason`). `ALLOWED["obsidian"]` gains
  `add_asana`. The rec drives both the card's proposed-date chip and the one-tap add.

The add is therefore **instant** — no per-tap LLM. If an item has no rec yet (triage
not run), Add to Asana still works: it creates with `due=null` (or the edit sheet lets
Frank pick a date).

## Frontend: features

1. **Per-source actions** — primary verb by source (gmail→Archive, slack→Mark read,
   asana→Complete, **obsidian→Add to Asana**). Card action row: primary · Open ↗ ·
   Snooze ⏰ · Hand-to-Gary 🤖 · Dismiss ✕ (and Delete 🗑 for gmail). Wrong combos
   fall back to `dismiss` (existing 400-guard pattern).
2. **Click-out** — `Open ↗` opens `meta.url` in a new tab.
3. **Read-in-place** — tap card body → reader (desktop overlay / mobile sheet) fetching
   `/api/inbox/slack/thread`, `/api/inbox/asana/task`, or the email body. State:
   `inboxReader = {key, item, data, loading, error}`.
4. **Snooze** — menu (Later today / Tomorrow 9am / Next week) → `action:"snooze"` with
   `until` epoch-ms. Time math is a pure, unit-tested helper.
5. **Undo + History** — toast after each action shows the verb + Undo (`/api/items/undo`
   with `undoTs`); History drawer lists `/api/items/history` with per-row undo. State:
   `inboxToast`, `inboxHistoryOpen`.
6. **AI recs** — `✨ Triage with Gary` button (exists) + per-card rec chip
   (reason/confidence, one-tap apply). Obsidian recs also show the proposed Asana
   due date.
7. **Working filter chips** — clicking a source chip sets `inboxFilter`; add the
   missing **Obsidian** chip; show per-source error badges from the feed's `errors`.
8. **Hand to Gary** — `/api/items/spinoff` → navigate to the new session.
9. **Add to Asana UX** — one-tap creates with the smart due date; toast: "Added →
   due Fri · Undo". Long-press / "Edit" opens a quick sheet (name + due-date chips:
   Today / Tomorrow / Fri / Next week / None) to adjust before creating. Plain
   **Dismiss** remains the secondary for noise.
10. **Mobile swipe** — extend `wireMobileGestures`: right = primary/rec action, left
    = Snooze | Dismiss; keep pull-to-refresh.

### State additions

`inboxReader`, `inboxSnoozeFor`, `inboxToast`, `inboxHistoryOpen`, `inboxFilter`,
`inboxEditFor` (Add-to-Asana edit sheet). Normalize `dismissed` to **string** ids
(the shell's mock used numbers — a latent bug when mixed with live string ids).

## Error handling

- Per-source action failures surface in the toast ("Couldn't archive — retry"),
  item is restored (optimistic remove is rolled back).
- Asana create failure → toast error, item stays in feed (not dismissed).
- Reader fetch failure (502) → inline "couldn't load" with a retry, card still
  actionable.
- Triage produces no `due` → add still works with no due date.

## Testing

- **Backend (pytest, `backend/tests/`):** new `test_inbox_asana` cases for
  `create_task`/`delete_task` (mock httpx); router cases for `add_asana` (success,
  undo-deletes, create-failure-keeps-item); `recommend` cases for the obsidian
  `task`/`due` parse + validation; `settings` case for `asana_section_gid` lookup.
- **Frontend (`node --test`, `node:test`):** pure helpers only — source→action
  mapping, snooze-time math, item→card mapping, filter predicate, due-date chip → ms.
  Render functions are string templates; assert key substrings for a sample state.
- **Live verification:** drive the running app (terminal/browser) for the real flows
  (archive, snooze, reader, undo, add-to-asana create+undo) before claiming done.

## Build & deploy

- Feature branch in `/home/frank/openclaw-workspace`; TDD per task; commit per green
  task; present merge options at the end (finishing-a-development-branch).
- Deploy requires `systemctl --user restart openclaw-workspace.service`. **Gary runs
  the restart** when the work is ready (confirmed).

## Risks / open items (resolve in planning)

- Confirm `frontend/` vs `frontend-overrides/` canonical source + sync step.
- Confirm Backlog section gid (lookup vs. hardcode `1206274018380402` from TOOLS.md).
- Asana "create in section" exact API call (memberships on create vs. add-to-section).
- Decide whether Add-to-Asana is obsidian-only initially or a universal secondary
  action (backend is generic either way; default: obsidian primary now, easy to
  expose elsewhere later).
