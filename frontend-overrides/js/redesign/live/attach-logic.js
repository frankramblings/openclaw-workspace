// Pure helpers for the composer attachment upload lifecycle (task 4.2).
// No DOM, no fetch — unit-tested by __tests__/attach-upload-state.test.js;
// wired by live/chat.js (uploadAttachments / send) and rendered by both
// shells' chip renderers (surfaces.js attachChip, mobile-surfaces.js
// mAttachChip).
//
// state.pendingAttach entry shapes:
//   { id, name, url }                  — uploaded, sendable (NO status key)
//   { id, name, status: 'uploading' }  — selection made, POST in flight
//   { id, name, status: 'failed' }     — upload failed; red removable chip
// The temp id is minted client-side at selection and swapped for the server
// id when the batch resolves; removeAttach filters on either id unchanged.

// Append one 'uploading' chip per picked file. Returns the new list plus the
// batch's temp ids so the fetch's resolve/fail path can find its own chips
// (and ONLY its own — a second selection mid-flight owns different ids).
export function beginUploads(pending, names, mintId) {
  const list = [...(pending || [])];
  const ids = [];
  for (const name of names || []) {
    const id = mintId();
    ids.push(id);
    list.push({ id, name: name || 'upload', status: 'uploading' });
  }
  return { list, ids };
}

// Swap each still-present uploading chip for its saved counterpart, in batch
// order. A chip the user removed mid-flight stays removed — its saved record
// is dropped, not resurrected — while later chips still get their OWN records
// (the queue is consumed by batch position, not list position). If the server
// saved fewer files than requested, the unmatched chips flip to 'failed'
// rather than silently vanishing.
export function resolveUploads(pending, ids, saved) {
  const batch = ids || [];
  const savedByPos = new Map();
  batch.forEach((id, i) => savedByPos.set(id, (saved || [])[i]));
  const out = [];
  for (const a of (pending || [])) {
    if (!batch.includes(a.id)) { out.push(a); continue; }
    const s = savedByPos.get(a.id);
    if (s) out.push({ id: s.id, name: s.name || a.name, url: s.url });
    else out.push({ ...a, status: 'failed' });
  }
  return out;
}

// Whole-batch failure: flip this batch's chips to 'failed' (red, removable).
export function failUploads(pending, ids) {
  const batch = ids || [];
  return (pending || []).map((a) => (batch.includes(a.id) ? { ...a, status: 'failed' } : a));
}

// The chips a send may actually carry: only resolved uploads (no status).
export function sendableAttach(pending) {
  return (pending || []).filter((a) => !a.status);
}

// Composer send gate. 'uploading' outranks 'failed': the in-flight batch may
// still resolve, so that's the message the user should see first.
export function uploadGate(pending) {
  const list = pending || [];
  if (list.some((a) => a.status === 'uploading')) return 'uploading';
  if (list.some((a) => a.status === 'failed')) return 'failed';
  return 'ok';
}
