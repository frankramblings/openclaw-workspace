# UNIT-403 — thread markdown export

## Objective
"Export as Markdown" on the current chat → downloads `<session-name>.md`.

## Inputs / context
- Spec decision 3. `src/tabs/chat/ChatHeader.tsx` — existing header controls
  (a download/copy affordance may exist; if a menu exists, add an item, else
  a button matching chrome).
- History shape: what the chat store holds (`history.data` bubbles — roles,
  text, attachments) — export from the STORE's loaded history for the
  active session (no refetch; if history isn't loaded the affordance is
  disabled).

## Approach
- exportMarkdown.ts: pure `renderThreadMarkdown(sessionName, bubbles) ->
  string`: `# <session name>` header + per bubble `## User` / `## Gary`
  (assistant display name if the app has one — discover; else 'Assistant')
  + raw text verbatim (code fences pass through untouched), attachments as
  `[name](path)` lines, separated by blank lines. Then a small
  `downloadMarkdown(filename, text)` using Blob + object URL + revoke.
  Filename: session name sanitized (`[^a-z0-9-_ ]` stripped, spaces→`-`,
  fallback 'chat') + `.md`.
- Header wiring: disabled while history not ready; click → render + download.
- Tests: renderer — roles mapped, fences verbatim (incl. a fence containing
  `## ` lines — must not be treated as structure), attachments listed,
  empty-history yields header only; filename sanitization edge cases;
  download helper revokes its object URL.

## Constraints
- Pure renderer separate from DOM trigger (testable without jsdom URL
  mocking beyond the helper test). No new deps.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; counts reported and increased
- [ ] (assertional) fence content byte-verbatim in output; no refetch on export; disabled state honest

## Dependencies
none
