// Pure formatting for token usage (kept DOM-free for unit tests).
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

function _pos(u, k) { return u && Number(u[k]) > 0; }

export function usageLine(usage, ctxPct) {
  if (!usage || (!_pos(usage, 'input') && !_pos(usage, 'output'))) return '';
  let s = `↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}`;
  if (ctxPct != null && !Number.isNaN(Number(ctxPct))) s += ` · ${Math.round(Number(ctxPct))}% ctx`;
  return s;
}

const _grp = (n) => (Number(n) || 0).toLocaleString('en-US');

export function usageTitle(usage) {
  const u = usage || {};
  return `input ${_grp(u.input)} · output ${_grp(u.output)} · cache read ${_grp(u.cacheRead)} · cache write ${_grp(u.cacheWrite)}`;
}

export function sessionTotalsLine(totals, costed) {
  if (!totals || (!_pos(totals, 'input') && !_pos(totals, 'output'))) return '';
  let s = `Session: ↑${fmtTokens(totals.input)} ↓${fmtTokens(totals.output)}`;
  if (costed && Number(totals.totalCost) > 0) s += ` · $${Number(totals.totalCost).toFixed(2)}`;
  return s;
}
