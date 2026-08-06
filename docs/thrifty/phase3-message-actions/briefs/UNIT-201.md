# UNIT-201 — edit-and-resend

## Objective
Pencil tool on user messages → inline textarea → Save truncates + resends;
Cancel restores. Store-backed edit mode.

## Inputs / context
- CONTRACT.md store additions (binding). Spec decisions 1-2.
- `src/tabs/chat/store.ts`: read `regenerate` (~line 376) — editMessage is its
  sibling: same idle guard (`liveTurn` status check), same truncate call
  (`keep_count` = the USER message's own index, so the edited message itself
  is removed and re-sent), same `send(text, { attachments })` — preserve the
  ORIGINAL message's attachments.
- `Message.tsx`: existing tools row (copy/download/branch/regenerate) — add
  the pencil for `role === 'user'`; render textarea swap when
  `editingMessageId === bubble.id`.
- Existing tests: `store.test.ts` regenerate cases (mock `apiJson` truncate +
  send), `Message.test.tsx` interaction style from phase 2.

## Approach
- Store: `editingMessageId`, `startEdit(id)` (no-op unless idle + user msg),
  `cancelEdit()`, `editMessage(id, text)` per contract — on success edit mode
  clears; on failure surface `sessionError` and KEEP edit mode + text (no
  data loss).
- Component: textarea prefilled with `bubble.text`, autofocus, Save button +
  ⌘/Ctrl+Enter, Cancel button + Esc. Disable Save while `editMessage` is in
  flight (pending flag or local state). Empty text + no attachments → Save
  disabled.
- Styles: edit textarea fills the bubble width, monospace-free, matches
  composer look; Save/Cancel row right-aligned.
- Tests: store — happy path (truncate called with right keep_count, send
  called with edited text + original attachments, history sliced); guard
  paths (streaming → startEdit refuses; assistant/absent id refuses; truncate
  API failure keeps edit mode + sets error). Component — pencil only on user
  messages when idle; textarea swap + prefill; Esc restores original
  rendering; Save disabled when empty.

## Constraints
- Do not modify `regenerate` in this unit. Do not lose typed text on failure.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; counts reported before/after and increased
- [ ] (assertional) truncate keep_count equals the edited message's index (message itself removed); attachments preserved verbatim; no code path drops typed text without explicit Cancel

## Dependencies
none
