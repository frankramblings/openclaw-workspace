// Pure formatting for token usage (kept DOM-free for unit tests).
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

const _n = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : Number(v) || 0);

// The prompt side of a turn. claude-cli stamps assistant messages with
// placeholder input/output (about 2/1) and puts the real prompt volume in
// cacheRead/cacheWrite; the gateway's own totalTokens is the sum of all four,
// so the up-arrow is input + cacheRead + cacheWrite for every provider.
function promptTotal(u) {
  return _n(u.input) + _n(u.cacheRead) + _n(u.cacheWrite);
}

// claude-cli never reports a real output count, so we omit the down-arrow
// rather than print a placeholder "↓1".
const _noOutput = (opts) => (opts && opts.provider) === 'claude-cli';

export function usageLine(usage, ctxPct, opts) {
  if (!usage) return '';
  const up = promptTotal(usage);
  const down = _n(usage.output);
  if (up <= 0 && down <= 0) return '';
  let s = `↑${fmtTokens(up)}`;
  if (!_noOutput(opts)) s += ` ↓${fmtTokens(down)}`;
  if (ctxPct != null && !Number.isNaN(Number(ctxPct))) s += ` · ${Math.round(Number(ctxPct))}% ctx`;
  return s;
}

const _grp = (n) => (Number(n) || 0).toLocaleString('en-US');

export function usageTitle(usage, opts) {
  const u = usage || {};
  let s = `input ${_grp(u.input)} · output ${_grp(u.output)} · cache read ${_grp(u.cacheRead)} · cache write ${_grp(u.cacheWrite)}`;
  if (_noOutput(opts)) s += ' · output not reported by claude-cli';
  return s;
}

export function sessionTotalsLine(totals, costed, opts) {
  if (!totals) return '';
  const up = promptTotal(totals);
  const down = _n(totals.output);
  if (up <= 0 && down <= 0) return '';
  let s = `Session: ↑${fmtTokens(up)}`;
  if (!_noOutput(opts)) s += ` ↓${fmtTokens(down)}`;
  if (costed && Number(totals.totalCost) > 0) s += ` · $${Number(totals.totalCost).toFixed(2)}`;
  return s;
}
