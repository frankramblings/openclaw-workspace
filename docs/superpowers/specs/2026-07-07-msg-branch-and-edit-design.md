# Message-level Branch + Edit — Workspace PWA

Date: 2026-07-07
Owner: Frank / Gary

## Summary

Two per-message affordances in the Workspace PWA chat surface:

1. **Branch conversation here** — from any message (Frank's or Gary's), fork a new
   session seeded with the transcript prefix up to and including that message.
   The original session is untouched.
2. **Edit last message** — Frank's most recent user message is editable until Gary
   starts answering it. When Gary begins, the affordance disappears. Once an
   assistant message follows a user message, that user message is no longer the
   most-recent-editable one.

Both are hover-toolbar buttons on the message, next to the existing Copy and
Download tools.

## Design goals

- **No transcript pollution.** After branching, the new session looks like the
  conversation always lived there. After editing, only the final text of the
  edited message appears in the log — no "correction" turn.
- **Preserve the original.** Branch never mutates the source session.
- **Fit the append-only brain.** The gateway has no `edit`/`delete`/`truncate`
  RPC. We work with what exists (`chat.inject`, `chat.abort`, `chat.send`) and
  gate writes at the workspace backend where we still own the buffer.
- **Fail loud, degrade gracefully.** If a race closes the edit window, the UI
  removes the affordance and Frank isn't left staring at a saved-but-ignored
  edit.

## Non-goals

- Editing arbitrary older user messages (only the most-recent-editable one).
- Editing assistant messages.
- Deleting messages.
- Reordering / merging messages.
- Cross-session move.

## User-visible behavior

### Branch here

- Hover any message → a third tool button appears in `.msg-tools` (icon: git
  branch fork). Both user and assistant messages get it.
- Click → workspace posts to backend, backend creates the new session and seeds
  it, then responds with the new `session_id`.
- Frontend hard-navigates to the new session (same tab, sidebar selection
  updates), title = `↳ <original title> — from msg <N>` where N is the 1-indexed
  position in the source transcript.
- The composer is empty and focused. Frank types the next thing and Gary
  continues as though the prior turns really happened in this thread.

### Edit last message

- Frank's most recent user message shows a **pencil** tool button in its
  hover toolbar iff both conditions hold:
  1. No assistant message follows it in the current transcript.
  2. No assistant streaming is currently active for this session.
- Click → the `.msg-body` swaps to an inline `<textarea>` prefilled with the
  current text. Save (⌘/Ctrl+Enter or button) / Cancel (Esc or button).
- Save behavior depends on send state (see "Edit lifecycle" below).
- If the edit window has closed by the time Save fires, the UI shows a soft
  toast ("Gary already started — can't edit now") and re-renders the message
  without the pencil.

## Architecture

### Frontend

Everything lives in the existing redesign surface:

- `frontend-overrides/js/redesign/icons.js` — add `I.branch(size)` and
  `I.edit(size)` SVG helpers (git-fork + pencil).
- `frontend-overrides/js/redesign/surfaces.js` — `msgTools(m, openId, chat)`
  extends its returned HTML with:
  - a `branchFromMessage` button for every message,
  - an `editMessage` button on messages that pass the "editable" predicate.
  The editable predicate takes the message and the chat's message list; it
  returns true iff `m.role === 'user'`, `m.id` is the id of the last user
  message, no message with `role === 'assistant'` exists after it, and
  `chat.streaming !== true`.
- `frontend-overrides/js/redesign/app.js` — three new action handlers:
  - `branchFromMessage(id)` → POST to `/api/session/branch`, then
    `selectSession(new_session_id)`.
  - `editMessage(id)` → toggles the message-body DOM to edit mode, keeps a
    per-chat `editingMessageId` in local state so the render loop doesn't blow
    it away on the next stream frame.
  - `saveEdit(id, text)` → POST to `/api/message/{id}/edit`; on 200, re-render
    from history; on 409, remove pencil, show toast.
- `frontend-overrides/js/redesign/mobile/mobile-surfaces.js` — parallel adds
  to the mobile per-message action sheet. Mobile already has a long-press
  action sheet on messages; we add Branch and (when applicable) Edit rows.
- Streaming state (`chat.streaming`, `chat.currentAssistantMsgId`) is already
  tracked by `stream-manager.js` — the edit predicate reads it directly.

### Backend

Two new endpoints in `backend/app.py`, one new module `backend/message_edit.py`
for the send-buffer, and additions to `backend/bridge.py` to call
`chat.inject` and `chat.abort`.

#### `POST /api/session/branch`

Form fields:
- `source_session_id` (required)
- `up_to_message_id` (required)
- optional overrides: `name`, `model`, `speed`

Steps (server-side, sequential; failures abort with a clear error):

1. Load the source session via `sessions_store.get(source_session_id)`.
   404 if missing.
2. Fetch its full transcript via `bridge.fetch_history(source.sessionKey,
   limit=1000)`. This uses `chat.history` — the same path `/api/history` uses.
3. Locate `up_to_message_id` in the returned list. 404 if not found.
   Slice = messages `[0..idx]` inclusive.
4. Create the new session via `sessions_store.create(name=..., model=source.model,
   endpoint_url=source.endpoint_url, endpoint_id=source.endpoint_id,
   speed=source.speed)`. Name defaults to `↳ <source.name> — from msg <idx+1>`
   unless overridden.
5. For each message in the slice, call `bridge.gateway_call("chat.inject",
   {"sessionKey": new_session.sessionKey, "message": {"role": m.role,
   "content": m.content, ...preserved_meta}, "label": ...})`.
   - Injects are sequential (not parallel) so ordering in the brain matches the
     slice order.
   - Retries: on transient failure, retry that message up to 3× with backoff.
     On permanent failure, delete the half-populated new session and return 502.
   - Attachments: image attachments live in the workspace sidecar
     (`_persist_msg_attachments`), not in the brain payload. On branch, we
     also copy sidecar rows keyed to the new session's id + the new
     transcript's positional indices.
6. Response: `{"session_id": new_session.id, "session_key": new_session.sessionKey}`.

#### `POST /api/message/{message_id}/edit`

Form fields:
- `session_id` (required — the session the message belongs to)
- `content` (required — the new text)

The edit resolves through a **send-buffer** owned by `message_edit.py`. See
"Edit lifecycle" below. Responses:

- `200 {ok: true, applied: "buffered"}` — the outgoing `chat.send` was still
  buffered; payload swapped, timer reset.
- `200 {ok: true, applied: "reissued"}` — the run had a runId but no assistant
  tokens yet; we `chat.abort`ed the run and reissued `chat.send` with the new
  text (this path relies on the brain's `chat.abort` cleanly rolling back the
  user message on the current turn — see "Open questions" if it doesn't).
- `409 {ok: false, reason: "already_answered"}` — Gary has emitted at least one
  token; edit refused.
- `404` — message not found or not the most-recent editable message.

## Edit lifecycle (the send-buffer)

Today: composer submit → `chat_stream` handler → `bridge.stream_turn` → `chat.send`
is called immediately, gateway records the user message and starts the run.

New: composer submit → `message_edit.enqueue(session_key, payload)` returns
a `MessageEditHandle`. The handle:

- Holds the outgoing `chat.send` params in memory keyed by `message_id`
  (the id we generate client-side for optimistic rendering — the same id the
  edit endpoint will receive).
- Waits up to `EDIT_BUFFER_MS` (default **300ms**) before actually firing
  `chat.send`. During that window, an incoming `POST /api/message/{id}/edit`
  can swap the payload atomically and return `applied: "buffered"`.
- After the buffer window expires, `chat.send` is called. From this point the
  handle transitions to `state: "sent"` and edit either takes the "reissued"
  path (abort + resend, allowed only until the first assistant token) or fails
  with 409.
- On first assistant frame observed by `_record_turn`, the handle transitions
  to `state: "answering"`. All subsequent edit requests return 409.
- On `chat.abort` from the reissue path, we suppress the abort's terminal
  DONE frame from being surfaced to the UI (so the user doesn't see a
  half-cancelled turn), and immediately fire the new `chat.send`.

Buffer discipline:

- Only one buffered send per session at a time.
- If the user sends a second message while one is buffered, the first buffer
  is flushed synchronously before enqueueing the second (preserves order).
- Client shows a 300ms progress ring on the sent bubble so nothing looks
  frozen. This ring doubles as the visible "edit window" — Frank can see
  it's still editable.

## Data model touch-points

- `sessions_store.create` already returns a full session record with
  `sessionKey`. No schema changes.
- No schema changes to attachments sidecar; branch just copies rows to the
  new session id.
- `message_id` today is generated client-side and echoed back through the
  transcript. The edit endpoint uses that same id — no new id-space.

## Failure modes and handling

| Case | Behavior |
|------|----------|
| `chat.inject` transient failure mid-branch | Retry 3× w/ backoff. On permanent fail, `sessions_store.delete(new_id)` and return 502 with message. |
| Source session not found | 404. |
| Source message id not in transcript window | 404. Frank sees a toast; retry may fetch a fresh transcript. |
| Edit arrives after `chat.send` has fired but before first token | Attempt `chat.abort` + reissue. If abort fails, 409. |
| Edit arrives after first assistant token | 409, UI removes pencil, toast. |
| Two edits arrive in a race | Second edit sees the buffered payload has changed handle state; returns whatever state applies at that moment. |
| Buffered send is orphaned (client disconnects mid-buffer) | Fires normally after buffer expires; the user's send still lands. |
| Client renders "editable" but backend disagrees | 409/404 recovers the UI. Backend is the source of truth. |

## Testing

- `backend/tests/test_session_branch.py` — mock `bridge` with an in-memory
  transcript, exercise happy path, missing id, permanent inject failure
  cleanup, and attachment sidecar copy.
- `backend/tests/test_message_edit.py` — fake clock + fake bridge, verify:
  buffered swap, buffered-then-flushed to real send, reissue path abort+resend,
  409 after first token, edit request for non-most-recent message.
- Frontend Jest test in
  `frontend-overrides/js/__tests__/msg-tools.test.js` — snapshot of `msgTools`
  output for (user last, user not-last, assistant, streaming-active) states.

## Rollout

- Feature is inert until the frontend renders the buttons. Backend endpoints
  can ship first without any UI change.
- Ship behind no feature flag; scope is small and Frank is the only user.
- After merge, do the standard workspace deploy:
  `scripts/sync-frontend.sh && systemctl --user restart openclaw-workspace.service`.

## Open questions

1. **`chat.abort` on a run with a stored user message but zero assistant
   tokens** — does the abort roll the transcript back so a subsequent
   `chat.send` with different text produces a clean single-user-turn history,
   or does the aborted user turn stay in the log? This determines whether the
   "reissued" path is truly clean or falls back to Edit-B (correction append)
   after the 300ms buffer closes. Verify during implementation with a small
   probe; if unclean, we lengthen the buffer to ~700ms (giving Frank more time
   inside the clean window) and drop the reissue path entirely (edits after
   buffer close return 409).

2. **`chat.inject` role support** — the handler honors an arbitrary `role`
   field (chat-BA3ikhey.js:1150), but the wrapping function is named
   `appendAssistantTranscriptMessage`. Confirm end-to-end that a
   `role: "user"` inject renders as a user bubble in `chat.history` output
   before we depend on it in the branch endpoint. If it silently downgrades
   to assistant, we fall back to seeding the prefix as a synthesized
   system-prompt blob and rendering the pre-branch messages client-side from
   the source session's history.
