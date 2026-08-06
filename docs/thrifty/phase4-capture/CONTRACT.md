# Phase 4 — Capture — Contract

**Decomposition mode:** partition
**Planning tier:** direct

## Objective

Voice dictation (backend transcribe + composer recorder) and paste/drop into
the existing upload pipeline. Spec (binding, read first):
`docs/superpowers/specs/2026-07-21-phase4-capture-design.md`.
Units: 301 backend, 302 recorder, 303 paste/drop.

## Conventions

- Backend style per `backend/` norms; ruff-clean (E4/E7/E9/F); tests in
  `backend/tests/test_transcribe.py` using the project's FastAPI test-client
  fixture (find how test_push.py gets a client — copy that). `.venv/bin/python`.
- Frontend: `/next` honesty rule; no new npm deps; styles → app.css var()
  palette. Baseline: 260 tests, 257 passing, 3 known failures (composer ×2,
  ModelPicker ×1) — never touch, never grow; counts strictly increase per
  test-adding unit; never delete existing tests.
- No git commands (unrelated WIP in repo). No service restarts (orchestrator
  deploys).

## Interfaces (cross-unit)

**HTTP** (owner 301; consumed by 302):
- `GET /api/transcribe/status` → `{"supported": bool}`
- `POST /api/transcribe` — multipart field `audio` (filename + content-type
  passed through) → `{"text": str}` on 200; `{"error": str}` with 4xx/5xx
  (503 when unsupported, 400 no/empty file, 502 upstream failure). Max
  upload 25 MB (reject 413).

**Recorder state** (owner 302): composer-local state machine
`idle → recording → transcribing → idle`, with `error: string | null`
rendered inline. Mic button visibility = `status.supported === true` AND
`navigator.mediaDevices?.getUserMedia` exists (checked once per mount via
the status endpoint — a tiny module-level cached fetch, not per-render).

**Upload reuse** (owner 303): refactor Composer's `upload(event)` into
`uploadFiles(files: File[])` used by all three entry points (input change,
paste, drop). Attachment helpers (`beginUploads`/`resolveUploads`/
`failUploads`) unchanged.

## Ownership map

- UNIT-301 → `backend/transcribe.py` (new), `backend/app.py` (two routes),
  `backend/tests/test_transcribe.py` (new)
- UNIT-302 → `Composer.tsx` (mic button + recorder), `src/tabs/chat/
  useRecorder.ts` (new hook: MediaRecorder lifecycle), app.css, tests
- UNIT-303 → `Composer.tsx` (uploadFiles refactor + paste/drop handlers +
  drop-target styles), tests

## Dependency graph

```text
UNIT-301 → UNIT-302        UNIT-303 (independent)
```
Executor order: 301, 302, 303.

## Gates

- 301: `.venv/bin/python -m pytest backend/tests/test_transcribe.py -q`,
  then full `backend/tests -q`; ruff via `.venv/bin/python -m ruff check
  backend` IF available else note skipped.
- 302/303: `cd frontend-next && npm run build && npm test` — vitest summary
  verbatim, counts before/after.
