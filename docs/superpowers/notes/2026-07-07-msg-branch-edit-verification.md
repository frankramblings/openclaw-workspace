# msg-branch-edit — verification note (2026-07-07)

Branch: `msg-branch-edit` (12 commits ahead of `main` merge-base `446deb0`, head `826e6e1`).

## What shipped

**Desktop-side** (both features fully functional and covered by tests):

- **Branch conversation here** — hover any message → git-fork button → new session opens with the source thread's messages rendered as "carried" bubbles above an empty composer. On the first send in that session, the backend prepends a serialized preamble so Gary continues with full context. Original session untouched.
- **Edit last message** — every composer send runs through a 700 ms client-side buffer. During that window the optimistic bubble shows a draining conic-gradient ring and grows a pencil button; tap Edit → inline textarea → Save & Send flushes immediately with the edited text (or Cancel keeps the original, or Esc). After the ring closes, the pencil disappears.

**Deferred:**
- **Task 9 — mobile action-sheet parity.** No existing per-message action sheet, no long-press-on-message gesture, no Copy row on mobile. Building the sheet infrastructure is out-of-scope for this branch. Track as a follow-up needing its own brainstorm + spec.

## Deploy status

- `scripts/sync-frontend.sh` succeeded (SW cache stamped `gary-6b5749bf4f`).
- `systemctl --user restart openclaw-workspace.service` → active; `http://127.0.0.1:8800/` returns 200.
- No startup errors in journalctl (only pre-shutdown streaming-cancel traces from the previous process, expected).

## Automated coverage

- Backend: 681 passed in full suite, including new tests for `branch_context` (4), `POST /api/session/branch` (3), first-send preamble prepend + web-search interaction (4).
- Frontend (node:test): all new tests pass — `redesign-send-buffer.test.js` (buffer state machine + latest-text-wins + second-submit ordering), `redesign-send-buffer-unload.test.js` (pagehide flush), `redesign-branch-prefix.test.js` (carried bubbles render), `redesign-branch-from-message.test.js` (9 slicing + branchFromMessage cases), `redesign-edit-message.test.js` (5 saveEdit/cancelEdit/branchPrefix-cleanup cases), `msg-tools.test.js` (button predicate).
- Three pre-existing test failures (`redesign-markdown.test.js` fenced-code + 2 in `redesign-msg-tools.test.js`) predate this branch — verified identical at merge-base by two independent reviewer subagents. Not regressions.

## What still needs Frank's eyes (manual e2e)

I cannot click a live browser. Please spot-check:

1. **Branch happy path.** Open a chat with ≥3 messages. Hover message #2 → git-fork icon → click. Confirm:
   - Sidebar shows a new session titled `↳ <original> — from msg N`.
   - New session's transcript shows messages #1 + #2 as slightly-faded "carried" bubbles above an empty composer, with a "↳ carried from source thread" caption above the first.
   - Original session unchanged.
   - Type a new message → Gary responds as if the prior turns were always there (server-side preamble prepended on first send).
   - After the first turn completes, the "carried" caption is gone (localStorage cleaned, `chat.history` now has the enriched real turn).

2. **Edit inside buffer.** Send a message with a typo. Within ~700 ms tap the pencil → fix the typo → Save & Send. Confirm Gary answers the corrected version and the transcript shows only the corrected text.

3. **Edit after buffer.** Send a message, let the ring drain (Gary starts replying). Confirm the pencil disappears — no Edit available.

4. **Empty-text edit → drops the send.** Send a message. Within the buffer, tap Edit → clear the textarea → Save & Send. Confirm the optimistic bubble vanishes and no message is sent (added as part of final-review Minor #1 fix).

5. **Web search + branch.** Open a branched session with web-search toggled on, send a message. Confirm Gary receives BOTH the branch preamble AND the web-search context (this was the Task-4 review Critical — regression-tested by `test_chat_stream_websearch_on_first_send_keeps_branch_preamble`, but a live smoke would be reassuring).

6. **Mobile.** Mobile users can still send/receive normally; there just won't be any Branch or Edit affordance on mobile until the mobile action-sheet follow-up ships.

## Follow-ups (from progress ledger — deferred, not blocking merge)

- Task 2: session-id sanitize only strips `/`; unlink OSError silently ignored on consume. Not exploitable in single-user tool.
- Task 3: new-session name drops the "— from msg N" suffix (cosmetic). No validation on prefix item shape.
- Task 7: `postStream` should add `keepalive: true` on its fetch to survive hard tab close mid-buffer (browsers may abort non-keepalive fetches during `pagehide`). `BUFFER_MS` duplicated in JS + CSS keyframe.
- Task 8: minor redundant renders on action paths. `clearBranchPrefixIfStarted` sits inside `try` block in `selectSession` — cleanup skipped on fetch error.
- Task 9: mobile action-sheet parity (fully deferred — see above).
- Preamble hard-codes `Frank:` / `Gary:` personas rather than `__AGENT_NAME__`. Fine for Frank's instance; Marissa's clone would say "Frank:" in her preambles.
- Prefix `_carried` bubbles still render `msgTools`. Copy/Branch on a carried bubble works but may be confusing UX — consider hiding tools on carried messages.

## Ready to merge?

Yes, from the final whole-branch review's verdict ("Ship it"). Zero Critical/Important findings; the one new Minor (empty-text via saveEdit) is fixed inline in commit `826e6e1`. All deferrals are known and low-severity.
