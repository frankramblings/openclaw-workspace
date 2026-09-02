// Pure HTML for Settings → Usage. Plain divs, no chart library.
import { fmtTokens } from './usage-view.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function usagePanelHtml(model) {
  const { days, daily = [], totals, costed, error } = model || {};
  const seg = `<div class="usage-seg"><button class="set-btn${days === 7 ? ' primary' : ''}" data-act="usageDays" data-arg="7">7 days</button><button class="set-btn${days === 30 ? ' primary' : ''}" data-act="usageDays" data-arg="30">30 days</button></div>`;
  if (error) {
    return `${seg}<div class="set-text">Usage could not be loaded (${esc(error)}). <button class="set-btn" data-act="usageRetry">Retry</button></div>`;
  }
  const max = Math.max(1, ...daily.map((d) => Number(d.totalTokens) || 0));
  const bars = daily.map((d) => {
    const v = Number(d.totalTokens) || 0;
    const pct = Math.round((v / max) * 100);
    const title = `${d.date}: ${fmtTokens(v)} tokens (↑${fmtTokens(d.input)} ↓${fmtTokens(d.output)})`;
    return `<div class="usage-col" title="${esc(title)}"><div class="usage-bar" style="height:${pct}%"></div><div class="usage-day">${esc(String(d.date || '').slice(5))}</div></div>`;
  }).join('');
  const t = totals || {};
  const missing = Number(t.missingCostEntries) || 0;
  const cost = costed
    ? `<div class="set-field"><span class="k">Estimated cost</span><span class="v">$${(Number(t.totalCost) || 0).toFixed(2)}</span></div>`
    : `<div class="set-text">Cost not available for subscription models (${missing} uncosted ${missing === 1 ? 'entry' : 'entries'} in this period). Tokens above are complete.</div>`;
  return `${seg}
  <div class="usage-chart">${bars || '<div class="set-text">No usage recorded in this period.</div>'}</div>
  <div class="set-field"><span class="k">Input</span><span class="v">${fmtTokens(t.input)}</span></div>
  <div class="set-field"><span class="k">Output</span><span class="v">${fmtTokens(t.output)}</span></div>
  <div class="set-field"><span class="k">Cache read / write</span><span class="v">${fmtTokens(t.cacheRead)} / ${fmtTokens(t.cacheWrite)}</span></div>
  <div class="set-field"><span class="k">Total</span><span class="v">${fmtTokens(t.totalTokens)}</span></div>
  ${cost}`;
}
