# UNIT-302 — composer mic + recorder hook

## Objective
Tap-to-record dictation in the composer: `useRecorder` hook + mic UI, result
appended to the draft.

## Inputs / context
- CONTRACT.md recorder state + spec decision 3 (binding).
- `Composer.tsx` — draft state lives here; find where text state is set to
  append the transcript (trim + single space join; cursor to end).
- Existing hook precedent: `src/tabs/chat/useStickToBottom.ts` (style),
  `useSuggest.ts`.

## Approach
- useRecorder.ts: owns getUserMedia({audio:true}) + MediaRecorder. mimeType:
  first supported of ['audio/mp4','audio/webm;codecs=opus','audio/webm'] via
  MediaRecorder.isTypeSupported. start() → recording (collect chunks);
  stop() → blob → POST /api/transcribe (FormData field `audio`, filename
  `clip.<ext by mime>`) → returns text. Auto-stop timer at 120 s. Release
  ALL tracks on stop/unmount/error (no dangling mic indicator). Permission
  denied → error state with human message, state back to idle.
  Tab hidden mid-recording: keep recording (iOS may suspend; handle
  onerror/dataavailable gaps gracefully — stop cleanly if the recorder
  errors).
- Composer: mic button beside the existing attach/send controls; visibility
  per contract (cached status fetch). States: idle mic; recording = pulsing
  red + elapsed seconds + tap stops; transcribing = spinner on the button;
  error = inline text near composer (reuse the existing `setNotice` pattern
  if suitable). Append transcript to draft on success.
- Styles: pulse animation + recording tint in app.css.
- Tests: hook with mocked MediaRecorder/getUserMedia — happy path posts blob
  and returns text; permission denied → error+idle; auto-stop fires at limit
  (fake timers); tracks released on stop and unmount; rapid tap-tap (stop
  before dataavailable) doesn't double-post. Component: mic hidden when
  unsupported; visible+wired when supported (mock status fetch + hook).

## Constraints
- No Web Speech API anywhere. No new deps. Draft text is never replaced —
  only appended.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; counts reported and increased
- [ ] (assertional) every exit path releases media tracks; no double-POST on rapid toggling; transcript append never clobbers typed draft

## Dependencies
UNIT-301
