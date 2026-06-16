// Pure, DOM-free helpers for email-modal triage (multi-select + bulk fan-out).
// Node-tested by scripts/test-email-triage-math.mjs. No imports — keep it pure.

// Return a NEW Set with `uid` toggled — never mutate the input, so callers can
// swap state._selectedUids to the result and renders see a fresh reference.
export function toggleInSet(set, uid) {
  const next = new Set(set);
  if (next.has(uid)) next.delete(uid); else next.add(uid);
  return next;
}

export function allSelected(visibleUids, selectedSet) {
  return visibleUids.length > 0 && visibleUids.every((u) => selectedSet.has(u));
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Aggregate per-item results ({uid, ok, error?}) into a tally.
export function summarizeBulk(results) {
  const failedUids = results.filter((r) => !r.ok).map((r) => r.uid);
  return { ok: results.length - failedUids.length, failed: failedUids.length, failedUids };
}
