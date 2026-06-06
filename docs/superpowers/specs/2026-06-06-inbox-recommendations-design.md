# Inbox v2.1 — Gmail Delete, Undo, ✨ Recommendations

**Date:** 2026-06-06
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-06-05-native-inbox-design.md` (native inbox, live since 2026-06-05)

## Goal

Three additions to the unified Inbox tab, user-approved in brainstorming:

1. A **Delete** button on gmail cards.
2. **Easy undo** for every action (one-click destructive actions stay; undo is
   the safety net): transient toast + a 🕒 history drawer.
3. **✨ Recommended actions** per item, surfaced as a clickable chip, produced
   by three layers: behavioral history → cheap heuristics → an on-demand
   LLM "Triage" pass that also classifies *act-on-it* items
   (✨ Draft reply / ✨ Hand to Gary).

Explicitly decided: recommendations are **one-click executable** (no confirm
step) because undo covers mistakes. Chip display only — the static per-source
primary button does NOT morph (rejected alternative: dynamic ✨ primary).

## Constraints

- Inference only through the OpenClaw gateway at subscription rate
  (`bridge.run_text`); one triage pass ≈ one brain turn. No per-item LLM calls
  at render time. Codex stalls/throttles must degrade to a visible error, not
  a hang (same pattern as `/api/email/ai-reply`).
- 2014 Mac mini, 8GB: no new daemons, no background polling. Triage is
  manual-trigger only (rejected alternatives: auto-on-open, cron pre-warm).
- Frontend edits live in `frontend-overrides/` only; script tags must live in
  `frontend-overrides/index.html` (the sync-injector-only approach silently
  drops tags — see memory of 2026-06-05 incident).
- Slack `mark_read` cannot be un-done remotely; undo restores the card only.

## 1. Gmail Delete

- `gmail.py` `map_items`: `actions` becomes
  `["archive", "delete", "dismiss", "snooze"]`.
- Router `action()` gains: `elif act == "delete" and source == "gmail":
  await email_himalaya.delete(item_id); state.dismiss(..., "deleted")`.
  (`email_himalaya.delete()` exists — moves to Trash.)
- UI: cards render their action buttons FROM `item.actions` (replaces the
  hardcoded button row; primary stays first, 🗑 for `delete`, then the fixed
  snooze/open/gary/dismiss tail). Only gmail advertises `delete`.

## 2. Undo — toast + history drawer

### State (`backend/inbox/state.py` additions)

Two new top-level keys in `inbox-state.json` (same atomic-write + lock):

- `history`: list, newest first, capped at 100:
  `{source, id, title, action, ts, undo: {...}}`. Appended by every successful
  router action (including chip-executed recommendations).
- `stats`: per-sender/channel action counters feeding the history
  recommendation layer: `{"gmail:ada@example.com": {"archive": 4, "delete": 9},
  "slack:#general": {"mark_read": 7}, ...}`. Incremented alongside history.
  Counter key: gmail → sender address; slack → channel handle; asana/obsidian →
  not counted (no stable "sender" notion; their items are needs-you by nature).

### Undo mechanics (per action)

| action | undo |
|---|---|
| dismiss / reviewed | remove `dismissed` key → card returns |
| snooze | remove `snoozed` key |
| mark_read (slack) | remove `dismissed` key (remote read state stays — documented in the drawer row as "restored card") |
| complete (asana) | `PUT /tasks/{gid} {completed: false}` + remove dismissed key |
| archive / delete (gmail) | move the message back to INBOX by **Message-ID** + remove dismissed key |

Gmail specifics (adjusted 2026-06-06 after live verification): himalaya's
query grammar supports only from/to/subject/body/date/flag — there is NO
header (Message-ID) search. Undo therefore stores `undo: {folder:
"[Gmail]/All Mail"|"[Gmail]/Trash", from}` plus the item title (= subject),
and resolves the message's uid *in the target folder* (IMAP uids are
per-folder — the original uid is useless after a move) with a
`subject "..." and from "..."` query (verified working). Subjects from
himalaya envelope lists can carry a trailing truncation `…` and embedded
quotes — both are stripped; IMAP SEARCH is substring-based so the prefix
matches. New helpers in `email_himalaya.py`: `move_message(uid, src, dest)`
(raises on failure — also fixes a latent bug where the router awaited the
endpoint-shaped `archive()`, which returns a JSONResponse on error, so failed
IMAP moves still dismissed the card) and `find_uid(folder, subject,
from_addr)`. If the search finds no match at undo time, undo returns 502 and
the history entry is restored for retry.

### Endpoints

- `GET /api/items/history?limit=20` → `{entries: [...]}` (undo-ability flag per
  row).
- `POST /api/items/undo {ts}` → executes the undo for the matching history
  entry (ts is the entry's unique timestamp key), removes it from history,
  decrements the stat counter, pops the source cache. Errors → 502 with
  message (e.g. message not found in Trash anymore).

### UI

- Toast: bottom of the modal, `Archived "Re: budget" — Undo`, ~8s, one at a
  time (newest wins). Clicking Undo calls the endpoint and reloads the feed.
- 🕒 button in the modal header toggles the body into a history list (last 20):
  `action · title · age · [Undo]`. Non-undoable rows show the reason instead
  of a button.

## 3. Recommendation layers + chip

### Module: `backend/inbox/recommend.py` (pure, unit-testable)

`recommend(item, stats, ai_recs) -> rec | None` where
`rec = {action, reason, by: "ai"|"history"|"heuristic", confidence?}`.

Precedence: **ai > history > heuristic** (the LLM saw the most context; the
chip shows at most one rec).

- **history layer:** counter for the item's sender/channel has ≥3 total
  actions and one action ≥80% share → recommend it. Reason:
  `"you archived 4/4 from this sender"`.
- **heuristic layer (v1 rules):**
  - gmail: sender matches `noreply|no-reply|notifications?@|newsletter|
    mailer-daemon|@e\.|@email\.|@mail\.` (case-insensitive, against the
    address) → `archive`, reason `"newsletter/notification sender"`.
  - slack: kind == unread (not mention), age > 7 days → `mark_read`,
    reason `"stale channel chatter"`.
  - asana, obsidian: no heuristic rec (needs-you by nature).
- `/api/items` attaches `rec` to each item (computed at merge time; cheap).

### Chip UI

Under the card subtitle: `✨ Archive — newsletter/notification sender`
(clickable, `inbox-rec-chip` class, dimmed styling for `confidence: "low"`).
One click executes the mapped action through the normal `doAction` path
(so it logs history, shows the undo toast, decrements counts). For
`reply`/`gary` recs the chip routes to the spinoff flow (section 4).

## 4. ✨ Triage pass (LLM) + act-on-it intents

### `POST /api/items/triage`

Body: `{}` (operates on the current merged visible feed). Flow:

1. Collect visible items lacking an `ai` rec (cap 120; if more, take
   highest-score first and report the cap in the response).
2. Build ONE prompt: numbered list of `{id, source, title, subtitle, snippet,
   ageHours}` + instruction to return STRICT JSON
   `[{id, action, confidence: high|med|low, reason: <≤8 words>}]` with
   `action ∈ archive|delete|mark_read|complete|reviewed|reply|gary|none`,
   constrained per source (e.g. `reply` only for gmail; `delete` only for
   gmail). `none` = no recommendation.
3. `bridge.run_text(prompt, session_key=config.INBOX_TRIAGE_SESSION_KEY)` —
   a NEW dedicated constant (e.g. `"workspace-inbox-triage"`) so triage turns
   never pollute the shared web chat session.
4. Parse robustly (strip code fences, tolerate trailing prose, drop entries
   with unknown ids/disallowed actions). Persist into the state file:
   `recs: {"source:id": {action, confidence, reason, ts}}`. Pruned lazily on
   each triage write: drop any cached rec whose `ts` is older than 7 days AND
   whose key is absent from the current feed.
5. Response: `{scored: N, skipped: M, errors: ...}`. Empty/garbled brain reply
   → 503 with a clear message (toast in UI), nothing cached.

### UI

`✨ Triage` button in the modal header; spinner while running (the turn takes
seconds); on success, reload the feed (recs now attached). Cached recs render
on every open with zero latency until items vanish.

### Spinoff intents (act-on-it)

`POST /api/items/spinoff` gains optional `intent`:

- `intent: "reply"` (gmail only): handler fetches the email body
  (`email_himalaya` read, `mark_seen=false`, truncated ~4000 chars) and the
  saved writing style (same `_load_style()` used by ai-reply — exposed or
  imported), seeds Gary: *"Draft a reply to this email in my style; show me
  the draft and iterate with me. I'll send it from the Email tab."*
- `intent` absent / `"gary"`: current behavior (context brief seed).

## 5. Data flow summary

```
/api/items ──merge──> per item: rec = ai_cache ?? history(stats) ?? heuristic
                                          ▲                ▲
✨ Triage button ──POST /triage──> 1 brain turn ──> recs cache (state file)
card chip click ──POST /action (or /spinoff intent=reply|gary)
/action success ──> history entry + stats counter ──> toast w/ Undo
🕒 drawer ──GET /history──> rows ──POST /undo──> reverse + restore card
```

## 6. Testing

- Unit (pure): heuristic rules table; history-layer thresholds (3/80%);
  precedence ai>history>heuristic; triage prompt builder caps + per-source
  action constraints; JSON parser (fenced, dirty, partial); undo-record
  construction per action; stats counter round-trip.
- Router (monkeypatched sources + fake `run_text`): action→history+stats;
  /history shape; /undo per action incl. gmail message-id path (fake
  himalaya); /triage happy + garbled-brain 503; chip-driven action identical
  to button-driven.
- Live smoke: archive→undo round-trip on a real newsletter (verify back in
  INBOX); one ✨ triage pass on the real feed (eyeball recs + reasons); a
  `reply`-intent spinoff produces a draft session.

## 7. Rollout (3 independently-usable increments)

1. **Delete + undo:** actions-array-driven buttons, 🗑, history/stats store,
   toast + drawer, undo endpoints.
2. **Instant chips:** recommend.py heuristic+history layers, chip UI.
3. **✨ Triage:** /triage endpoint, header button, ai layer, spinoff intents.

Same discipline as v2: TDD per task, stage explicit paths only (concurrent
sessions are active in this repo), restart `ai.openclaw.workspace` to deploy,
script tags live in `frontend-overrides/index.html`.

## Out of scope (YAGNI, discussed and deferred)

- Dynamic ✨ primary button (chip may graduate later once recs earn trust).
- Bulk "✨ Sweep / clear all safe" (layer on top of triage if wanted).
- Auto-triage on open; cron pre-warm.
- Slack reply/post actions (write path beyond mark_read).
- Confidence-gated confirm steps (undo is the safety net).
