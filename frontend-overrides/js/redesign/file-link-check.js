// Un-link file mentions that can't actually open (Frank, 2026-10-18: "they are
// broken right there"). markdown.js linkifies anything path-shaped, including
// repo-relative paths and directories that don't resolve against any root.
// After each render, batch-check every unchecked .file-link against
// POST /api/workspace/exists and demote misses to plain text, so anything
// that still looks like a link is one that opens.
const cache = new Map(); // `${root}|${path}` -> boolean
let timer = null;

function keyOf(el) {
  return `${el.getAttribute('data-root') || 'workspace'}|${el.getAttribute('data-arg') || ''}`;
}

function apply(el, ok) {
  el.setAttribute('data-fl', ok ? 'ok' : 'missing');
  if (ok) return;
  el.classList.remove('file-link');
  el.removeAttribute('data-act');
}

async function sweep() {
  timer = null;
  const els = [...document.querySelectorAll('.file-link[data-act="wsOpenFile"]:not([data-fl])')];
  if (!els.length) return;
  const pending = [];
  for (const el of els) {
    const k = keyOf(el);
    if (cache.has(k)) apply(el, cache.get(k));
    else if (!pending.includes(k)) pending.push(k);
  }
  if (!pending.length) return;
  const items = pending.map((k) => {
    const i = k.indexOf('|');
    return { root: k.slice(0, i), path: k.slice(i + 1) };
  });
  let exists;
  try {
    const r = await fetch('/api/workspace/exists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!r.ok) return; // fail open: leave links as rendered
    ({ exists } = await r.json());
  } catch (_) {
    return;
  }
  pending.forEach((k, i) => cache.set(k, !!exists[i]));
  for (const el of document.querySelectorAll('.file-link[data-act="wsOpenFile"]:not([data-fl])')) {
    const k = keyOf(el);
    if (cache.has(k)) apply(el, cache.get(k));
  }
}

function schedule() {
  if (!timer) timer = setTimeout(sweep, 120);
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
schedule();
