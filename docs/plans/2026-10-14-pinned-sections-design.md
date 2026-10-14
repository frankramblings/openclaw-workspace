# Pinned sections: conversation sidebar and model picker

Date: 2026-10-14
Status: DRAFT, awaiting approval (no code written)

## Goal

1. The conversation sidebar (desktop) and drawer (mobile) get a PINNED section at the very top. A pinned thread always appears there and also in every other section it belongs to.
2. The model picker (desktop popover, mobile sheet) gets a PINNED group at the top. A pinned model appears there and also under its endpoint group.
3. Overlap in the sidebar is limited to: PINNED, OPEN, the thread's project, and (unfiled threads only) the date bucket.

## Decisions (made with Frank)

- Projects stay out of the date buckets. Filed threads appear under their project, not under TODAY/YESTERDAY/etc.
- Model pins are stored server-side so they sync between desktop and phone.
- "Pinned" threads use the existing Favorite flag (`important`, the star). No new thread field.
- Model pins use a pin glyph, not a star. The star already means "default model for new chats".

## Current behavior (what changes)

`frontend-overrides/js/redesign/thread-groups.js` builds the groups. Today every thread lands in exactly one section:

- OPEN removes its threads from projects and date buckets (`openIds`).
- Pinned shelf holds only unfiled threads, and pinned threads are skipped in date buckets (`if (s.important) continue`).
- The pinned shelf is emitted after OPEN and the projects.

## Design: thread groups (pure logic)

`buildThreadGroups` returns, in order:

1. `pinned` (label `★ PINNED`): every non-archived thread with `important`, regardless of project or OPEN membership. Recency order, flat (no fork nesting). A pinned thread in an archived project still shows here, because pinning is explicit. Omitted when empty. `meta.count` added.
2. `open`: same selection and cap rules as today, but no longer removes threads from other sections.
3. `project` groups: rows now include threads that are also on OPEN. Roll-ups (`count`, `working`, `unseen`, `latest`) are unchanged since they already counted all threads. Archived projects still hide their threads (except via PINNED and OPEN).
4. `recent` date buckets: unfiled threads only, now including those that are pinned or on OPEN.

Rows gain no new fields. Section identity comes from the group's `kind` (and `meta.id` for projects).

## Design: renderers

Desktop (`surfaces.js` `convListBody`), mobile (`mobile-sheets.js`):

- `pinned` gets its own header with a count, matching the OPEN header style. The first group is no longer assumed to be OPEN for the `top` class: it is whichever group comes first.
- Row menu: `rowMenuOpen` is currently a bare thread id, so a thread that appears twice would open its menu in both places. The menu state gains the section it was opened from (`rowMenuSect`), and a menu renders only on the row whose section matches. `toggleConvMenu` takes the section along with the id.
- Active highlight, working spinner, unread dot and queued dot render on every copy (they describe the thread, not the row).
- `⌥N` slot badge and the "remove from Open" button render only in OPEN.
- Drag-to-project works from any copy.
- Filtering: while a filter is typed, rows are de-duplicated by id across sections (first section in display order wins), so a match is not listed three times. Section counts during a filter reflect rendered rows, as today.
- Alpha sort still applies within each section.

Out of scope: the Cmd+K switcher (`switcher.js`) builds its own MRU sections and is unchanged.

## Design: model pins

Backend (`backend/app.py`, next to `/api/default-chat`):

- `GET /api/pinned-models` returns `{"items": [{"model": "...", "endpoint_id": "..."}]}` read from `websearch.load_settings()["pinned_models"]` (default `[]`).
- `POST /api/pinned-models` with `{"model", "endpoint_id", "pinned": true|false}` adds or removes one entry and saves via `websearch.save_settings`. Idempotent. Requires a non-empty model. It does NOT run the offline-endpoint pair guard: pinning a model whose endpoint is temporarily down is fine.
- Stored order is pin order. Pins that do not resolve in the current catalog are kept in storage and skipped at render time.

Frontend:

- `loadModelOptions` also fetches `/api/pinned-models` and stores `state.live.pinnedModels` as an ordered list of composite ids (`endpoint·model`).
- New action `togglePinModel` (desktop) and `mTogglePinModel` (mobile): optimistic update, POST, roll back and toast on failure. Neither selects the model nor closes the menu.
- `modelPopover` and the mobile model sheet render a `PINNED` group first when at least one pin resolves in the catalog. Rows look identical to endpoint rows (check mark, default star) and carry a pin button. In the endpoint groups the pin button shows filled when pinned.
- With zero pins the output is byte-identical to today, so existing picker tests keep passing.

## Error handling

- Pin POST fails: revert the UI, show a toast, no retry loop.
- Pin list GET fails: treat as no pins; the picker still works.
- Stale pins (model removed from catalog): skipped, not shown, not deleted.

## Testing (TDD, node:test and pytest)

- `thread-groups.test.js`: rewrite the tests that assert "no duplicates across sections". New assertions: a pinned+open+project thread appears in PINNED, OPEN and its project; an unfiled thread appears in PINNED, OPEN and its date bucket; a filed thread never appears in a date bucket; a thread never appears twice within one section; PINNED is first; archived threads never appear anywhere.
- `sidebar-render-kinds.test.js`: pinned header, count, and `top` class on the first group; menu renders only on the matching section; slot badge and close button only in OPEN; filter de-dupes.
- `redesign-model-picker.test.js`: no pins gives the existing output; pins render a PINNED group first and still render in the endpoint group; unresolved pins are skipped; pin button does not trigger `setModel`.
- Mobile model sheet and conv drawer: parallel tests (`mobile-conv-sheet`, `model-sheet-retry` patterns).
- `backend/tests`: GET empty, POST add, POST add twice is idempotent, POST remove, missing model returns 400.

## Delivery

- Source of truth is `frontend-overrides/`. After commits, run `scripts/sync-frontend.sh` (it restamps cached assets) and `systemctl --user restart openclaw-workspace.service`. Commit before syncing, because Marissa's bundle sync ships only committed files.
- Verify in the browser on desktop and mobile width: pin a thread, pin a model, reload, confirm both persist and the stale-bundle check passes.

## Open risks

- Keyboard navigation or other code that finds rows by thread id via the DOM may assume one row per id. The plan includes a task to grep for this before touching renderers.
- The main list gets longer for unfiled threads that are pinned or open. Accepted.
