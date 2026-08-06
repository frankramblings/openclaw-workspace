# UNIT-301 — backend transcribe endpoint

## Objective
`backend/transcribe.py` + two routes: honest STT capability + multipart
transcription via the provisioned OpenAI key. Tests.

## Inputs / context
- CONTRACT.md HTTP shapes (binding). Spec decision 2.
- `backend/config.py` `_openclaw_json()` — read
  `skills.entries.openai-whisper-api.apiKey` at request time (NOT import
  time; key changes must not need restart). Missing/empty → unsupported.
- httpx is an existing dep; `backend/app.py` upload route (`/api/upload`) for
  multipart handling style; `test_push.py` for the test-client fixture.

## Approach
- transcribe.py: `supported() -> bool`; `async transcribe(filename,
  content_type, data: bytes) -> str` — httpx.AsyncClient POST to
  `https://api.openai.com/v1/audio/transcriptions` (multipart: file, model)
  with bearer key, timeout ~60 s. Model `gpt-4o-mini-transcribe`; on a
  model-not-found error response retry once with `whisper-1`. Raise a
  module-specific exception on upstream failure; app.py maps errors → 502
  with a human message (no key/API details leaked).
- app.py routes per contract. 25 MB cap checked from the uploaded payload
  size (413).
- Tests (mock httpx via monkeypatch or respx-free hand mock): status
  supported/unsupported (monkeypatch config read); happy path returns text;
  model-fallback path; upstream 500 → 502; no file → 400; oversize → 413;
  key never appears in any response body (assert).

## Constraints
- No new deps. Key never logged. Endpoint inherits global auth middleware.

## Acceptance criteria
- [ ] (runnable) `.venv/bin/python -m pytest backend/tests/test_transcribe.py -q` passes; full `backend/tests -q` stays green (report counts)
- [ ] (assertional) shapes match contract; key read at request time; no key/PII leakage in errors or logs

## Dependencies
none
