// Copy for the empty-promise amber card (Phase 3). Pure — tested by
// __tests__/promise-warning.test.js. The card is a nudge, not an error:
// honest about the consequence, quiet about the mechanics.
export function promiseWarningText(phrase) {
  const quoted = phrase ? `“${phrase}”` : 'A follow-up was promised';
  // Pings are off by default now (config.PROMISE_WAKE_ENABLED). The card's job
  // changed from "we'll try to deliver this" to "this won't arrive; here's what
  // will" — the task row, which does not depend on the agent remembering.
  return `${quoted} — Pings are off. This turn promised to report back; `
    + `watch the task row instead.`;
}

// The hydrate anchor rule (same as hydrateThread's update-block matching):
// latest assistant message whose _ts ≤ the event's timestamp; falls back to
// the OLDEST assistant message when nothing qualifies (ts missing, or the
// event predates every timestamped message). NOT the newest: an anchor that's
// wrong-but-early just reads as "this is an old promise", while wrong-but-
// newest reads as "the LATEST reply broke its promise" — actively misleading
// when that reply had nothing to do with it. Exported pure for tests and
// shared use.
export function latestAsstAtOrBefore(asstMsgs, tsMs) {
  if (!Array.isArray(asstMsgs) || !asstMsgs.length) return null;
  let best = asstMsgs[0];
  if (Number.isFinite(tsMs)) {
    for (const m of asstMsgs) {
      if (m._ts <= tsMs) best = m;
    }
  }
  return best;
}
