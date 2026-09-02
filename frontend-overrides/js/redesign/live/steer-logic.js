// Pure decision core for "what does Send do while this thread is busy?"
// (live/chat.js). Extracted so the routing is unit-testable without the DOM.
//
//   'steer' -> POST /api/chat/steer: the message is injected into the RUNNING
//             turn (Claude Code style). Only when the backend reports the
//             gateway steer patch AND the session runs on claude-cli AND the
//             message is text-only. Anything else could be absorbed into a
//             gateway follow-up run the bridge is not relaying, so it queues.
//   'queue' -> today's behavior: a pending banner, auto-sent when the turn ends.
//   'send'  -> the thread is idle; a normal turn.
export const STEER_ENDPOINTS = ['claude-cli'];

export function busySendMode({ busyHere, steerAvailable, endpointId, hasAttachments, forceQueue }) {
  if (!busyHere) return 'send';
  if (forceQueue) return 'queue';
  if (!steerAvailable) return 'queue';
  if (!STEER_ENDPOINTS.includes(String(endpointId || ''))) return 'queue';
  if (hasAttachments) return 'queue';
  return 'steer';
}

// After a steer POST failed: the turn ended in the meantime (no_active_turn)
// -> the message is simply a new turn now; every other failure -> queue it so
// it goes out when the turn finishes, never lost.
export function steerFallback(status, body) {
  if (status === 409 && body && body.reason === 'no_active_turn') return 'send';
  return 'queue';
}
