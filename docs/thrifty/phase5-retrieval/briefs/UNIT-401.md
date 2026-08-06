# UNIT-401 — backend /api/palette

## Objective
Cross-source lexical search endpoint per the contract shape. Tests.

## Inputs / context
- CONTRACT.md HTTP shape (binding). Spec decision 1.
- Source data lives server-side — DISCOVER each store's read API and document
  in palette.py's docstring: sessions (`backend/sessions_store.py` — list +
  name/updated), notes / documents / email (find their modules via app.py's
  existing routes: grep `/api/notes`, `/api/document`, `/api/email` handlers
  and use the same underlying stores those handlers use — read paths only).
- `backend/transcribe_routes.py` as the router-module pattern; test-client
  fixture per `test_transcribe.py`.

## Approach
- palette.py: `async search(q, limit) -> list[dict]`. Per source: load items
  via the store's existing read API (NO new caching layer; these are
  single-user-scale lists), compute rank tier (title-prefix=0,
  title-substr=1, content-substr=2; case-insensitive), tie-break recency
  desc. Snippet: title-match → first ~100 content chars; content-match →
  ~100 chars centered on the first hit, matched fragment intact. Merge
  sorted, cap at limit. Empty q → recent sessions only. Content search must
  bound work (read at most the store's already-available content fields; do
  NOT fetch full chat histories — sessions match by TITLE only, semantic
  content search is /api/search's job).
- Email: search the locally-cached/indexed messages the email module already
  holds (subject + sender + body if available) — never trigger network
  fetches from a search keystroke.
- Route: `GET /api/palette` in a small router module. Errors: q too long
  (>200 chars) → 400; a failing SOURCE degrades (skip + log once), never
  500s the whole palette.
- Tests: rank ordering across tiers; recency ties; empty-q recents; dedupe
  sanity; per-source failure degrades gracefully (monkeypatch one source to
  raise); 400 long q; shapes exact.

## Constraints
- Read-only endpoint; zero mutations. No network calls. No new deps.

## Acceptance criteria
- [ ] (runnable) `.venv/bin/python -m pytest backend/tests/test_palette.py -q` passes; full `backend/tests -q` stays green (counts reported)
- [ ] (assertional) shapes match contract; keystroke path provably does no network I/O and no full-history fetches; one bad source can't break the endpoint

## Dependencies
none
