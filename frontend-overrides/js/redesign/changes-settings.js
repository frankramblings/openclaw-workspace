// Pure HTML for Settings → Changes: watched roots, prune list, cache size,
// rebuild button. No DOM, no fetch. See live/settings.js for the loader and
// actions that feed `model` here.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = (n) => `${((Number(n) || 0) / 1048576).toFixed(1)} MB`;

export function changesSettingsHtml(model) {
  const m = model || {};
  const cfg = m.config || { roots: [], prune_dirs: [], max_bytes: 262144 };
  const stats = m.stats || { blobs: 0, blob_bytes: 0, roots: [] };
  const byPath = new Map((stats.roots || []).map((r) => [r.path, r]));
  const roots = (cfg.roots || []).map((p) => {
    const has = byPath.has(p);
    const r = byPath.get(p) || {};
    // No stats entry for this root is the same signal as exists:false, the
    // backend only reports on roots it actually scanned, so an absent entry
    // means it isn't on disk either (or hasn't been scanned yet).
    const det = (!has || r.exists === false) ? 'not found on disk' : `${Number(r.files) || 0} files indexed`;
    return `<div class="set-field"><span class="k" style="font-family:var(--mono)">${esc(p)}</span><span class="v">${esc(det)} <button class="set-btn danger" data-act="changesRemoveRoot" data-arg="${esc(p)}">Remove</button></span></div>`;
  }).join('');
  const rb = m.rebuild || {};
  const rebuildBtn = rb.running
    ? `<button class="set-btn" disabled>Rebuilding ${esc(rb.root || '')}…</button>`
    : `<button class="set-btn" data-act="changesRebuild">Rebuild index</button>`;
  return `
  ${roots || '<div class="set-text">No roots watched.</div>'}
  <div class="set-field"><span class="k">Add root</span><span class="v"><input class="set-input" data-model="changesRootDraft" data-focus="changesRootDraft" value="${esc(m.draftRoot || '')}" placeholder="/absolute/path" style="flex:1;min-width:0;width:100%;background:transparent;border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--fg);font-family:var(--mono)"> <button class="set-btn primary" data-act="changesAddRoot"${m.saving ? ' disabled' : ''}>Add</button></span></div>
  <div class="set-text">Pruned directory names (one per line, wildcards allowed):</div>
  <textarea class="set-textarea" data-model="changesPruneDraft" data-focus="changesPruneDraft" rows="6" style="width:100%;box-sizing:border-box;min-height:120px;font-family:var(--mono);font-size:12px">${esc(m.pruneDraft != null ? m.pruneDraft : (cfg.prune_dirs || []).join('\n'))}</textarea>
  <div class="set-buttons"><button class="set-btn" data-act="changesSavePrune"${m.saving ? ' disabled' : ''}>Save prune list</button></div>
  <div class="set-field"><span class="k">Cache</span><span class="v">${esc(Number(stats.blobs) || 0)} cached copies · ${esc(mb(stats.blob_bytes))} · files up to ${esc(Math.round((cfg.max_bytes || 0) / 1024))} KB</span></div>
  <div class="set-buttons">${rebuildBtn}</div>
  ${m.error ? `<div class="set-text" style="color:var(--red)">${esc(m.error)}</div>` : ''}`;
}
