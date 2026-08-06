# Phase 5 — Retrieval — Contract

**Decomposition mode:** partition
**Planning tier:** direct

## Objective

Backend palette search + shell ⌘K palette UI + thread markdown export.
Spec (binding, read first):
`docs/superpowers/specs/2026-07-21-phase5-retrieval-design.md`.
Units: 401 backend, 402 palette UI, 403 export.

## Conventions

- Backend norms as prior phases; tests `backend/tests/test_palette.py` via
  the existing test-client fixture; `.venv/bin/python`; full suite baseline
  1252 green. No new deps.
- Frontend: `/next` honesty rule; no new npm deps; styles → app.css.
  Baseline: 267 tests, 264 passing, 3 known failures (composer ×2,
  ModelPicker ×1) — never touch, never grow; counts increase per
  test-adding unit; never delete existing tests.
- No git commands (unrelated WIP in repo). No service restarts.

## Interfaces (cross-unit)

**HTTP** (owner 401; consumed by 402):
- `GET /api/palette?q=<str>&limit=<int, default 20>` →
  `{"results": [{"kind": "session"|"note"|"document"|"email",
  "id": str, "title": str, "snippet": str, "ts": int|null}]}`
  ranked best-first across sources (title-prefix > title-substring >
  content-substring; ties by recency). Empty/whitespace q → `{"results":
  [...recent sessions only, kind "session", newest first, ≤ limit]}`.
- Chat SEMANTIC hits come from the EXISTING `/api/search?q=` (unchanged);
  the palette UI merges client-side: semantic chat hits appear in the Chats
  group below title-match sessions, deduped by session id.

**Palette↔navigation** (owner 402): one helper
`src/shell/palette/navigate.ts` `openResult(r: PaletteResult): void` —
switches tab via the registry mechanism + selects the item via that tab's
store (chat: `useChatStore.getState().selectSession(id)`; others: discover
each store's select/open action and document in the file header).

**Export** (owner 403): self-contained in the chat tab; renders from the
same history shape the chat store already holds/fetches.

## Ownership map

- UNIT-401 → `backend/palette.py` (new), route in `backend/app.py` (or a
  small router module mirroring transcribe_routes.py), `backend/tests/
  test_palette.py`
- UNIT-402 → `src/shell/palette/` (new: Palette.tsx, store.ts, navigate.ts,
  tests), shell mount + ⌘K listener (discover shell root component), rail
  search affordance, app.css styles
- UNIT-403 → chat header menu item + `src/tabs/chat/exportMarkdown.ts`
  (new, pure function + download trigger) + tests

## Dependency graph

```text
UNIT-401 → UNIT-402        UNIT-403 (independent)
```
Executor order: 401, 402, 403.

## Gates

- 401: `.venv/bin/python -m pytest backend/tests/test_palette.py -q` then
  full `backend/tests -q`.
- 402/403: `cd frontend-next && npm run build && npm test` — vitest summary
  verbatim, counts before/after.
