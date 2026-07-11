// Copy for the empty-promise amber card (Phase 3). Pure — tested by
// __tests__/promise-warning.test.js. The card is a nudge, not an error:
// honest about the consequence, quiet about the mechanics.
export function promiseWarningText(phrase) {
  const quoted = phrase ? `“${phrase}”` : 'A follow-up was promised';
  return `${quoted} — but no tracked task is registered for this chat, so you `
    + `will NOT be pinged when it finishes. Ask for it to be run through the `
    + `followup wrapper, or check back manually.`;
}

// The hydrate anchor rule (same as hydrateThread's update-block matching):
// latest assistant message whose _ts ≤ the event's timestamp; falls back to
// the last assistant message. Exported pure for tests and shared use.
export function latestAsstAtOrBefore(asstMsgs, tsMs) {
  if (!Array.isArray(asstMsgs) || !asstMsgs.length) return null;
  let best = asstMsgs[asstMsgs.length - 1];
  if (Number.isFinite(tsMs)) {
    for (const m of asstMsgs) {
      if (m._ts <= tsMs) best = m;
    }
  }
  return best;
}
