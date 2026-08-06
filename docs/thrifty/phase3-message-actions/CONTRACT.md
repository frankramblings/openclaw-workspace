# Phase 3 — Message actions — Contract

**Decomposition mode:** partition
**Planning tier:** direct

## Objective

Edit-and-resend on user messages + retry-with-model on assistant messages, in
`frontend-next/` only. Spec (binding, read first):
`docs/superpowers/specs/2026-07-20-phase3-message-actions-design.md`.
Two units: 201 edit, 202 retry-with-model.

## Conventions

- `/next` honesty rule; zustand store patterns as in `src/tabs/chat/store.ts`;
  NO new deps; NO backend changes; no git commands (unrelated WIP exists).
- Baseline gate: 230 tests, 227 passing, 3 known failures (composer ×2,
  ModelPicker ×1) — never touch, never grow. Test counts reported per unit,
  strictly increasing when tests are added; never delete existing tests.
- Styles → `src/styles/app.css`, var() palette.

## Interfaces (cross-unit)

- **Store additions** (owner 201): `editMessage(messageId: string, text:
  string): Promise<boolean>` — validates idle + user-message + non-empty text
  (or original attachments retained), truncates at the message index via the
  same call regenerate uses, then `send(text, { attachments: original })`.
  UI edit-mode state: `editingMessageId: string | null` + `startEdit(id)` /
  `cancelEdit()` in the store (survives re-renders during background
  refetches).
- **Retry API** (owner 202): extend `regenerate(messageId)` to
  `regenerate(messageId, opts?: { model?: string, endpointId?: string })` —
  when model given, `await setSessionModel(activeSessionId, model,
  endpointId)` and proceed with the truncate+resend only if it succeeded.
  Existing single-arg callers unchanged.
- Both units add tools to `Message.tsx`; 201 lands first and owns the
  edit-mode rendering; 202 adds the retry menu without restructuring 201's
  work.

## Ownership map

- UNIT-201 → `src/tabs/chat/store.ts` (editMessage/startEdit/cancelEdit),
  `Message.tsx` (pencil tool, textarea swap, keyboard handling), app.css
  (edit-mode styles), store + component tests
- UNIT-202 → `store.ts` (regenerate opts), `Message.tsx` (Retry-with menu —
  discover the header ModelPicker's data source and reuse it), app.css (menu
  styles), tests

## Dependency graph

```text
UNIT-201 → UNIT-202
```

## Gates

Every unit: `cd frontend-next && npm run build && npm test` — no failures
beyond the 3 known; report the vitest summary line verbatim + counts
before/after.
