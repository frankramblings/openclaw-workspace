# Inbox v2 — Rapid Triage + Entity Verification source

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plan
**Surface:** the **redesign** inbox (`frontend/js/redesign/`), NOT the classic
`frontend-overrides/js/inbox.js`. The 2026-06-07 swipe spec targeted the classic
file; this supersedes it for the live redesign surface.
**Builds on:** `2026-06-05-native-inbox-design.md` (the tab),
`2026-06-06-inbox-recommendations-design.md` (rec chips + undo),
`2026-06-25-inbox-classic-port-design.md` (current per-source action model).

## Problem

The Inbox works but is built for *tapping*, not *blasting*. Frank needs to clear
a growing pile fast. Concretely:

1. **Inconsistent cards.** Buttons vary per source (per-source roulette via
   `cardActions`), so muscle memory doesn't transfer.
2. **No swipe on the live surface.** `swipeIntent()` exists in
   `inbox-logic.js` but is unused in the redesign render.
3. **"Triage with Gary" is a no-op to the eye.** It caches AI recommendation
   chips but takes NO action and has no "apply all" — you press *Triage* and
   nothing gets triaged. (Confirmed in `recommend.py` + `__init__.py`
   `/api/items/triage`: it only writes recs, never mutates.)
4. **Entity verifications live on Signal, don't stick, and mis-type everyone.**
   The cortex `verify_entities.py` pipeline emits unverified names into
   `People_Pending.md`; a cron pages a review link to Signal. Decisions only
   persist if they write `verified:true` into `People_Pending_Overrides.json`,
   which the Signal flow often doesn't — so the same names resurface. And
   `extract_names()` has zero type inference, so "Automation Suite", "Impact
   Report", "All Hands Meeting" are all filed as **people**.

## Goal

One unified, swipe-driven triage list where every card behaves the same, Gary
can pre-sort and apply in a single confirmed batch, and entity verifications are
processed **in the inbox** with decisions that stick permanently.

Non-goals: no one-card-at-a-time focus mode (Frank explicitly rejected it); no
change to the collectors for gmail/slack/asana/obsidian/documents/calendar; no
new persistence layer for entities (reuse the existing overrides JSON + denylist).

## Decisions locked in brainstorming

- Keep the **list** (Needs-You / FYI split stays).
- **Swipe map:** right = the card's primary action; left-short = snooze;
  left-far = dismiss. Every swipe leaves one Undo toast.
- **"Triage with Gary" = Option A:** suggest → **Apply all** on one confirm tap.
  Never acts silently. Items Gary marks `none` stay in Needs-You.
- **Consistent button row on every card.**
- Keyboard shortcuts are an optional last phase.
- Entity decisions must write `verified:true` (or denylist) so they never
  reappear; a common-sense classifier pre-guesses person vs org/event/etc.

---

## 1. Canonical card + button model

A single card anatomy for all sources. `cardActions()` in
`frontend/js/redesign/live/inbox-logic.js` is rewritten to always return the
same *shape*, differing only in the labelled primary and the contents of the
overflow:

```
┌───────────────────────────────────────────────┐
│ [SRC] Sender · 3h                            ✕ │  ✕ = dismiss (top-right)
│ Subject / snippet (tap = open reader)          │
│ [ Primary ]   ⏰   🤖   ↗    ⋯                  │
└───────────────────────────────────────────────┘
```

- **Primary** — the one "clear" verb for the source, labelled:
  gmail→Archive, slack→Mark read, asana→Complete, obsidian→Add to Asana,
  documents→Reviewed, entities→Confirm `<type>`.
- **Affordance row (identical everywhere):** `⏰ Snooze · 🤖 Hand to Gary · ↗ Open`.
- **`⋯ More`** — expands source-specific secondaries only when they exist
  (gmail Reply/Delete; obsidian Complete/Reviewed). Keeps the main row invariant.
- **Calendar invites** are the sole exception: primary row is **Yes / Maybe / No**
  (RSVP → Google), affordances unchanged. Detected by `isInvite()`.

`cardButtonsHtml()` renders from this descriptor; overflow is a `data-act="toggleMore"`
disclosure storing open state in `state.inboxMoreFor` (mirrors `inboxSnoozeFor`).

### Unit boundary
`cardActions(item) -> { primary, affordances[], more[], isInvite }` stays a
pure function, fully unit-testable (extend `scripts/test/inbox-logic.test.mjs`).
Render and wiring consume it; no DOM/fetch in the logic module.

## 2. Entity Verification source (`entities`)

### 2a. Collector — `backend/inbox/sources/entities.py`
- Reads `People_Pending.md` YAML blocks (name, type, first_seen_in, source_refs).
- **Excludes** any entity whose canon name is `verified:true` in
  `People_Pending_Overrides.json` OR present in `Entity_Denylist.md`. This is the
  "never reappears" guarantee — reusing the exact resolution set
  `verify_entities.py` already computes.
- Emits inbox items: `source:"entities"`, `title:<name>`,
  `subtitle:"guessed: <type>"`, `snippet:<first evidence line text>`,
  `meta:{ canon, guessType, evidence:[refs], file }`, `ageHours` from first_seen.
- `actions: ["confirm","reclassify","not_entity","open","gary","snooze","dismiss"]`.

### 2b. Common-sense classifier — `guess_type(name) -> person|org|event|project|other`
Deterministic, pure, unit-tested. Precedence:
- **event/other:** trailing/again keywords `Meeting|Sync|Report|Update|Review|
  Party|Week|Session|Touchbase|Block|Promo|Recap|Standup|Offsite|Lunch|Mass`.
- **project/other:** `Suite|Kit|Program|Framework|Template|Campaign|Initiative|
  Launch|Rollout|Plan`.
- **org:** `Team|Inc|LLC|Corp|Group|Co|Labs|Partners|Agency|Networks|Cloud`.
- **person (default only if it looks like a name):** exactly 2 tokens, both
  TitleCase, first token in a common-given-name set OR no non-person keyword hit.
- Ambiguous → `other`. The card shows the guess; the "Triage with Gary" LLM pass
  may override via the existing rec mechanism (a new allowed action set for
  `entities`).

### 2c. Write-back — `backend/inbox/__init__.py` action router
New branch in `/api/items/action` for `source == "entities"`:
- `confirm` (optional `type` override) → set
  `overrides[canon] = {type, verified:true}`, save via the same JSON the script
  reads. Item clears.
- `reclassify` with `type` in {person,org,event,project,other} → same write with
  the chosen type + `verified:true`.
- `not_entity` → append name to `Entity_Denylist.md` (idempotent) + optionally
  `overrides[canon]={type:"noise",verified:true}`. Item clears.
- `snooze` / `dismiss` → local-only (reappears later, intended).
- All write-backs are **undoable**: capture prior override state in the undo log
  (existing `/api/items/undo` ts mechanism) so a mis-tap is reversible.

**Persistence contract:** writes go to
`OpenClaw_Vault/20_Reference/Knowledge/Entities/People_Pending_Overrides.json`
and `Entity_Denylist.md` — the identical files `verify_entities.py` consults on
its next run. No second source of truth. A tiny helper module
`backend/inbox/entities_store.py` owns read/merge/write (canonicalization via the
same `canon_name` rule) so the route stays thin and the logic is unit-testable
without HTTP.

### 2d. Entity card (purpose-built variant in `surfaces.js`)
```
ENTITY  "Automation Suite"   · guessed: project
seen in: gmail_important…#L14
[ Confirm project ]   Person  Org  Event  Other      ✕ not an entity
⏰  ↗
```
- Primary = **Confirm `<guess>`** (swipe-right commits it).
- Reclassify chips set type + confirm in one tap.
- **✕ / left-far swipe = Not an entity** (denylist) — the destructive-but-common
  choice, guarded by Undo.
- `↗ Open` jumps to the evidence source line.

### 2e. Cron change
`cortex-entity-verify-0840` stops paging a Signal review link. It keeps running
`verify_entities.py --write-pending` to refresh the pending file. Optional:
a **count-only** daily Signal nudge ("7 entities to verify in your inbox") gated
the same way as other proactive sends. Processing now lives in the inbox.

## 3. Swipe gestures (redesign surface)

Port the proven engine from the 2026-06-07 spec into the redesign render
(`frontend/js/redesign/`), driven by the existing `swipeIntent(dx,width)`:
- `right (dx>84)` → primary action for the card (entity: confirm guess).
- `left-short (-140<dx<-84)` → open snooze menu.
- `left-far (dx<-140)` → dismiss (entity: not_entity).
- Pointer Events, 1:1 tracking, rubber-band, velocity flick, spring snap-back,
  `pointer:coarse` gate, `prefers-reduced-motion` → 0ms. One Undo toast per commit.
- Lives in the redesign live layer (new `frontend/js/redesign/live/inbox-swipe.js`
  imported by the surface bootstrap) + CSS in the redesign stylesheet. Desktop
  unchanged (buttons remain the affordance).

## 4. Batch "Triage with Gary" (Apply-all)

- Keep the current `/api/items/triage` scoring pass (adds `entities` to the
  allowed-action map so Gary can guess entity types too).
- After scoring, the FYI header renders a **summary bar**:
  `✦ Gary suggests: archive 14 · mark 6 read · 2 → Asana   [Apply all] [Review]`.
  Counts derived client-side from cached recs (`rec.by==='ai'`).
- **New endpoint `POST /api/items/apply-recs`** — server iterates the cached recs
  for currently-live items, runs each through the same per-source action path,
  and records ONE undo batch token. Returns `{applied, failed, undoTs}`.
- Client shows a single Undo toast for the whole batch (`undoTs`). `Review`
  just scrolls to the FYI list (per-card chips still work individually).
- `none`-rec items are never in the batch and stay in Needs-You.
- Button post-state: label → "Triaged ✓ · N applied" so it never reads as a no-op.

## 5. Keyboard shortcuts (optional, last)

Global keydown in `app.js`, active only when `activeSurface()==='inbox'` and no
input focused: `j/k` move selection, `e` primary, `s` snooze, `g` Gary,
`x` dismiss, `u` undo, `Enter` open reader. Selection ring stored in
`state.inboxCursor`. Cheap because every action already exists in the `actions`
registry.

## Error handling

- Collector fails soft: an `entities` source error becomes a `⚠` chip
  (existing `errors` map), never blanks the feed.
- Entity write-back failure → optimistic card snaps back + retry toast (mirrors
  `runAction`). Overrides file is written atomically (temp + rename) to survive a
  concurrent `verify_entities.py` run.
- Apply-all partial failure → toast "Applied N, M failed"; undo still covers the
  N that landed.
- Classifier is best-effort; a wrong guess is a one-tap reclassify, never a block.

## Testing

- **Backend (pytest, existing `backend/tests/test_inbox_*`):** new
  `test_inbox_entities.py` — collector excludes verified/denylisted, emits shape,
  action router writes overrides + denylist, undo restores prior state, atomic
  write. `test_entities_classifier.py` — `guess_type` table of real examples from
  the current pending list (Automation Suite→project, Impact Report→other/event,
  All Hands Meeting→event, "Allie Joel"→person, etc.).
- **Frontend logic (`scripts/test/inbox-logic.test.mjs`):** canonical
  `cardActions` shape per source; overflow contents; entity chip actions;
  `swipeIntent` mapping incl. entity dismiss=not_entity.
- **Apply-all:** unit test the endpoint over a fixture feed with mixed recs +
  `none`; assert batch undo token and that `none` items are untouched.
- Manual: run on the live PWA (mobile + desktop) after each phase; verify a
  confirmed entity does not return after `verify_entities.py` re-runs.

## Build phases (each shippable, behind the test suite)

1. **Canonical card + button model** (`inbox-logic.js`, `surfaces.js`) — foundation.
2. **Entity source** — collector + `guess_type` + write-back + entity card +
   cron change. *Solves the immediate Signal pain; independently useful.*
3. **Swipe gestures** on the redesign surface.
4. **Batch Apply-all** for "Triage with Gary".
5. **Keyboard shortcuts** (optional).

Recommended order: **1 → 2** first (Frank's active pain), then 3–5.
