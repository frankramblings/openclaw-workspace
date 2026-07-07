# Gateway probe: chat.inject role + chat.abort rollback (2026-07-07)

Probe for `docs/superpowers/specs/2026-07-07-msg-branch-and-edit-design.md`
§Open questions #1 and #2, run against the live gateway backing the
`openclaw-workspace.service` unit. Throwaway script (`.tmp/probe-inject.py`,
deleted after this note was recorded) created a fresh session via
`sessions_store.create`, primed it with one real `chat.send` turn (needed
because `chat.inject` requires the session to already exist gateway-side —
`sessions_store.create()` is local-only bookkeeping), then exercised both
probes and printed the resulting `fetch_history()` transcript.

## Probe A — `chat.inject` role handling (Open question #2)

```
  inject(#1, intended-as-user) ack: {'ok': True, 'messageId': '3b9eb220-dfd6-4226-b2d1-d850cc4139c8'}
  inject(#2, assistant) ack: {'ok': True, 'messageId': '8ba4b655-b2ca-4b02-892a-d3623e4b25bb'}
  inject(with role field) ERROR: invalid chat.inject params: at root: unexpected property 'role'

--- HISTORY AFTER INJECTS ---
  role='user' text='PROBE_PRIMING_TURN'
  role='assistant' text='[probe-user]\n\nPROBE_USER_HELLO'
  role='assistant' text='[probe-assistant]\n\nPROBE_ASST_ACK'
```

**Verdict:** Silently downgrades to assistant. `ChatInjectParamsSchema` (read
from the installed gateway's compiled source) has no `role` field at all —
sending one is a hard schema-validation rejection — and the handler
unconditionally calls `appendAssistantTranscriptMessage`. There is no path in
this gateway build that writes a user-role message via `chat.inject`. The
`PROBE_USER_HELLO` inject landed as `role='assistant'` in history.

## Probe B — `chat.abort` rollback (Open question #1)

```
  abort ack: {'ok': True, 'aborted': True, 'runIds': [...priming run..., ...new run...]}
  send result: {'runId': '...', 'status': 'started'}

--- HISTORY AFTER ABORT ---
  role='user' text='PROBE_PRIMING_TURN'
  role='assistant' text='[probe-user]\n\nPROBE_USER_HELLO'
  role='assistant' text='[probe-assistant]\n\nPROBE_ASST_ACK'
  role='user' text='PROBE_ABORT_ME'
```

**Verdict:** Unclean. The aborted user turn (`PROBE_ABORT_ME`) stays in the
transcript as an orphaned `role='user'` entry with no assistant reply —
`chat.abort` does not roll back or remove the just-sent user message. A
follow-up `chat.send` would stack a second user turn after it, not produce a
clean single-user-turn history. (Also observed: `chat.abort` without a
`runId` aborted *every* active run for the session, not just the intended
one.)

## Decision

**FALLBACK: both.**

- **Edit-A-tight-buffer-only.** Drop the abort+reissue path entirely (abort
  doesn't clean up the transcript). Lengthen `EDIT_BUFFER_MS` from 300ms to
  ~700ms. Edits arriving after the buffer closes return `409` unconditionally.
- **Branch-as-system-prompt-blob.** `chat.inject` cannot seed user-role prefix
  messages (schema has no `role` field; handler hardcodes assistant). The
  branch endpoint will seed the pre-branch transcript as a synthesized
  system-prompt blob and render the copied messages client-side from the
  source session's history, instead of replaying them via `chat.inject`.

## Concerns

- Verify this against whatever gateway build actually ships to production —
  the installed dev-machine gateway (`~/.nvm/.../openclaw/dist/`) may not
  exactly match what the spec's line reference (`chat-BA3ikhey.js:1150`)
  assumed when it floated role support as plausible.
- `chat.abort` aborting all active runs for a session (not just a named
  `runId`) is a footgun worth remembering if the reissue path is ever
  revisited.
- Full raw command output and the corrected interface notes (bridge helper
  return shapes differ from what was assumed going in) are in
  `.superpowers/sdd/task-1-report.md`.
