// Region patching for render(). render() used to assign root.innerHTML for
// every state change, so a thread switch re-parsed the entire shell (a Chrome
// trace on a 1,700-thread list: ~83% of main-thread time in Parse HTML + set
// innerHTML, 3-20s long tasks). The shell is now a list of regions; only a
// region whose HTML changed is rebuilt, and a region that declares a "slot" of
// chunks (the sidebar rows) is reconciled chunk by chunk so unchanged rows stay
// the very same DOM nodes. Pure string -> DOM work, no app state.
//
// Contract: a region renders exactly ONE root element; a chunk renders exactly
// ONE element with no text nodes between chunks. Both are verified at runtime
// (snapshotAfterFull / parseOne); any violation makes the caller fall back to a
// full rebuild, so a broken assumption costs speed, never correctness.

function parseOne(doc, html) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = String(html).trim();
  const kids = tpl.content.childNodes;
  if (kids.length !== 1 || kids[0].nodeType !== 1) {
    throw new Error('region-patch: markup must be exactly one element');
  }
  return kids[0];
}

// Make `container`'s children match `next` (array of one-element html strings),
// given `prev` (what the container currently holds, same order). Identical
// chunks are matched one-to-one and kept (moved if needed); only new chunks are
// parsed. Returns { created, removed }.
export function reconcileChunks(container, prev, next) {
  if (container.childNodes.length !== prev.length) {
    throw new Error('region-patch: container out of sync with its snapshot');
  }
  const doc = container.ownerDocument;
  const prevNodes = Array.from(container.childNodes);
  const pool = new Map();
  prev.forEach((html, i) => {
    let q = pool.get(html);
    if (!q) pool.set(html, (q = []));
    q.push(prevNodes[i]);
  });
  let created = 0;
  const nextNodes = next.map((html) => {
    const q = pool.get(html);
    if (q && q.length) return q.shift();
    created++;
    return parseOne(doc, html);
  });
  const keep = new Set(nextNodes);
  let removed = 0;
  for (const n of prevNodes) {
    if (!keep.has(n)) { container.removeChild(n); removed++; }
  }
  let cursor = container.firstChild;
  for (const n of nextNodes) {
    if (n === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(n, cursor);
  }
  return { created, removed };
}

// regions: [{ key, full, shell?, chunks?, slotSel? }]. `full` is the region's
// complete html; a chunked region also gives `shell` (full with an empty slot),
// the `chunks` that fill the slot, and `slotSel` to find it.
//
// Verifies a just-rendered `body` (all regions set via innerHTML) lines up with
// the regions, and returns the snapshot to patch against next time, or null if
// the DOM doesn't match (patching stays off until the next full render).
export function snapshotAfterFull(body, regions) {
  if (body.children.length !== regions.length) return null;
  return regions.map((r, i) => {
    const snap = { ...r };
    if (r.chunks) {
      const slot = body.children[i].querySelector(r.slotSel);
      const aligned = slot && slot.childNodes.length === r.chunks.length
        && Array.from(slot.childNodes).every((n) => n.nodeType === 1);
      if (!aligned) snap.chunks = null;
    }
    return snap;
  });
}

// Patch `body` from the `prev` snapshot to `next` regions. Returns
// { snapshot, replaced } or null when patching isn't safe (layout changed or the
// live DOM drifted), in which case the caller rebuilds everything.
export function patchRegions(body, prev, next) {
  if (!prev || prev.length !== next.length || body.children.length !== next.length) return null;
  for (let i = 0; i < next.length; i++) if (prev[i].key !== next[i].key) return null;
  const doc = body.ownerDocument;
  const snapshot = next.map((r) => ({ ...r }));
  const replaced = [];
  for (let i = 0; i < next.length; i++) {
    const p = prev[i];
    const n = next[i];
    if (n.full === p.full) continue;
    const el = body.children[i];
    if (n.chunks && p.chunks) {
      const oldSlot = el.querySelector(n.slotSel);
      if (oldSlot && oldSlot.childNodes.length === p.chunks.length) {
        if (n.shell === p.shell) {
          reconcileChunks(oldSlot, p.chunks, n.chunks);
          replaced.push(`${n.key}:rows`);
          continue;
        }
        // Only the surrounding markup changed (search text, composer draft):
        // rebuild the shell, carry the existing rows across, then reconcile.
        const fresh = parseOne(doc, n.shell);
        const freshSlot = fresh.querySelector(n.slotSel);
        if (freshSlot) {
          while (oldSlot.firstChild) freshSlot.appendChild(oldSlot.firstChild);
          reconcileChunks(freshSlot, p.chunks, n.chunks);
          el.replaceWith(fresh);
          replaced.push(`${n.key}:shell+rows`);
          continue;
        }
      }
    }
    const fresh = parseOne(doc, n.full);
    el.replaceWith(fresh);
    replaced.push(n.key);
    if (n.chunks) {
      const slot = fresh.querySelector(n.slotSel);
      if (!slot || slot.childNodes.length !== n.chunks.length) snapshot[i].chunks = null;
    }
  }
  return { snapshot, replaced };
}
