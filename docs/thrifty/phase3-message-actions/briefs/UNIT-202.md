# UNIT-202 — retry-with-model

## Objective
"Retry with…" menu on assistant messages: pick a model → session model
switches → regenerate.

## Inputs / context
- CONTRACT.md Retry API (binding). Spec decision 3.
- `src/tabs/chat/store.ts`: `regenerate` (~376), `setSessionModel` (~532).
- `src/tabs/chat/ModelPicker.tsx`: discover where the header picker gets its
  model list (store/endpoint fetch) — REUSE that source; do not add a new
  fetch path. Note its known-failing test (`ModelPicker renders observed
  model groups…`) is one of the 3 baseline failures — don't touch that test.
- `Message.tsx`: regenerate tool from the existing row; UNIT-201 has added
  edit tooling — merge cleanly, don't restructure.

## Approach
- Store: `regenerate(messageId, opts?)` per contract. If `opts.model`:
  `await setSessionModel(...)`; abort (return false, surface error) if the
  PATCH fails — never truncate after a failed switch.
- UI: split-button or small popover menu on the regenerate tool: plain
  "Retry" (no opts) + model entries grouped as the header picker groups them.
  Current session model marked. Close on outside click/Esc. Keep it lean —
  no new dep, no portal unless the codebase already has a popover pattern
  (look for one; reuse if found).
- Styles: match existing menu/dropdown chrome in app.css if present; else
  minimal card popover per app palette.
- Tests: store — opts.model path calls setSessionModel BEFORE truncate;
  PATCH failure → no truncate, no send, error surfaced; single-arg behavior
  unchanged (existing regenerate tests must pass untouched). Component —
  menu opens/closes, selecting a model invokes regenerate with opts, plain
  Retry passes no opts.

## Constraints
- Existing regenerate call sites compile unchanged. No new deps.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; counts reported before/after and increased
- [ ] (assertional) failed model switch never truncates history; model list provably same source as header picker (no duplicated fetch)

## Dependencies
UNIT-201
