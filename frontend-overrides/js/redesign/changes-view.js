// Pure HTML/markup helpers for per-turn change review. No DOM, no fetch.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function totals(files) {
  let added = 0, removed = 0;
  for (const f of files || []) { added += Number(f.added) || 0; removed += Number(f.removed) || 0; }
  return { added, removed };
}

export function changesSummary(rec) {
  const files = (rec && rec.files) || [];
  if (!files.length) return '';
  const t = totals(files);
  return `Changes · ${files.length} ${files.length === 1 ? 'file' : 'files'} · +${t.added} −${t.removed}`;
}

const KIND = { added: 'A', modified: 'M', deleted: 'D' };

function fileRow(turnId, f) {
  const caps = [];
  if (f.shared) caps.push(`<span class="chg-cap">may include another chat's work</span>`);
  if (f.reverted) caps.push('<span class="chg-chip">reverted</span>');
  if (!f.diffable) caps.push('<span class="chg-chip muted">not diffable</span>');
  return `<div class="chg-file" data-act="changesOpen" data-arg="${esc(turnId)}:${esc(f.path)}"><span class="chg-kind k-${esc(f.kind)}">${KIND[f.kind] || '?'}</span><span class="chg-path">${esc(f.path)}</span><span class="chg-counts">+${Number(f.added) || 0} −${Number(f.removed) || 0}</span>${caps.join('')}</div>`;
}

export function changesCardHtml(rec, opts = {}) {
  const summary = changesSummary(rec);
  if (!summary) return '';
  const tid = rec.turn_id;
  const head = `<div class="chg-head" data-act="changesToggle" data-arg="${esc(tid)}"><span class="chg-caret">${opts.expanded ? '▾' : '▸'}</span><span class="chg-sum">${esc(summary)}</span></div>`;
  const body = opts.expanded ? `<div class="chg-list">${(rec.files || []).map((f) => fileRow(tid, f)).join('')}</div>` : '';
  return `<div class="chg-card${opts.expanded ? ' open' : ''}">${head}${body}</div>`;
}

export function diffHtml(text) {
  const lines = String(text || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = lines.map((l) => {
    let cls = 'ctx';
    if (l.startsWith('+++') || l.startsWith('---')) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    return `<span class="ln ${cls}">${esc(l)}</span>`;
  });
  return `<pre class="diff">${out.join('\n')}</pre>`;
}

export function changesPaneHtml(model) {
  const m = model || {};
  if (m.error) return `<div class="chg-pane"><div class="chg-empty">Changes could not be loaded (${esc(m.error)}). <button class="ocbtn" data-act="changesRefresh">Retry</button></div></div>`;
  const turns = (m.turns || []).map((t) => `<div class="chg-turn${m.open && m.open.turn === t.turn_id ? ' active' : ''}" data-act="changesTurn" data-arg="${esc(t.turn_id)}"><span class="t">Turn ${esc(t.turn_id)}</span><span class="s">${esc(t.files)} ${t.files === 1 ? 'file' : 'files'} · +${esc(t.added)} −${esc(t.removed)}${t.shared ? ' · shared' : ''}</span></div>`).join('');
  let detail = '';
  if (m.open && m.open.record) {
    const rec = m.open.record;
    const list = (rec.files || []).map((f) => fileRow(rec.turn_id, f).replace('class="chg-file"', `class="chg-file${m.open.path === f.path ? ' active' : ''}"`)).join('');
    let diff = '';
    if (m.open.path) {
      const f = (rec.files || []).find((x) => x.path === m.open.path) || {};
      const d = m.open.diff || {};
      const disabled = (!f.diffable && f.kind !== 'added') || f.reverted;
      const why = f.reverted ? 'Already reverted' : (!f.diffable ? 'No previous copy to restore' : '');
      diff = `<div class="chg-diff-head"><span class="p">${esc(m.open.path)}</span><button class="ocbtn danger" data-act="changesRevert" data-arg="${esc(rec.turn_id)}:${esc(m.open.path)}"${disabled ? ` disabled title="${esc(why)}"` : ''}>Revert this file</button><button class="ocbtn" data-act="changesCopy" title="Copy diff">Copy</button></div>${d.diffable ? diffHtml(d.text) : `<div class="chg-empty">Changed, not diffable (${esc(f.before_bytes || 0)} → ${esc(f.after_bytes || 0)} bytes).</div>`}`;
    }
    detail = `<div class="chg-detail"><div class="chg-list">${list}</div>${diff}</div>`;
  }
  return `<div class="chg-pane"><div class="chg-turns">${m.loading ? '<div class="chg-empty">Loading…</div>' : (turns || '<div class="chg-empty">No changes recorded for this chat yet.</div>')}<button class="ocbtn chg-refresh" data-act="changesRefresh" title="Refresh">⟳</button></div>${detail}</div>`;
}

export function attachChangesToThread(thread, turns) {
  const out = new Map();
  const asst = (thread || []).filter((m) => m.role === 'assistant' && m._ts != null);
  for (const t of (turns || [])) {
    const lo = (Number(t.started_ms) || 0) - 60000;
    const hi = (Number(t.ended_ms) || 0) + 5000;
    let best = null;
    for (const m of asst) {
      if (m._ts >= lo && m._ts <= hi) {
        if (!out.has(m.id)) {
          best = m;
          break;
        }
      }
    }
    if (best) out.set(best.id, t);
  }
  return out;
}
