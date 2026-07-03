// Pure inbox logic — no DOM, no fetch. Shared by live/inbox.js (wiring) and
// surfaces.js (render), and unit-tested by scripts/test/inbox-logic.test.mjs.
//
// The redesign skeleton hardcoded `dismiss` on every button and only styled
// gmail/slack/asana. This restores the classic behaviour: real per-source
// actions driven off the backend's `actions[]` list, all five sources styled,
// interactive source filtering, and backend-authoritative counts.

// Per-source brand colors for the .src-tag. Covers every source the backend
// emits (gmail, slack, asana, obsidian, documents); unknown → muted.
const SRC_STYLE = {
  GMAIL: { srcColor: 'var(--red)', srcBg: 'rgba(240,114,106,.12)' },
  SLACK: { srcColor: 'var(--green)', srcBg: 'rgba(91,217,127,.12)' },
  ASANA: { srcColor: 'var(--gold)', srcBg: 'rgba(232,194,104,.12)' },
  OBSIDIAN: { srcColor: 'var(--purple, #b794f6)', srcBg: 'rgba(183,148,246,.12)' },
  DOCUMENTS: { srcColor: 'var(--blue, #6aa6f0)', srcBg: 'rgba(106,166,240,.12)' },
  CALENDAR: { srcColor: 'var(--teal, #45d3c7)', srcBg: 'rgba(69,211,199,.12)' },
};
const MUTED = { srcColor: 'var(--muted)', srcBg: 'rgba(255,255,255,.06)' };

export function srcStyle(source) {
  return SRC_STYLE[String(source || '').toUpperCase()] || MUTED;
}

// Human labels for backend action verbs. Unknown verbs are humanized
// (snake_case → "Sentence case") so a new backend action still reads sanely.
const ACTION_LABEL = {
  add_asana: 'Add to Asana',
  archive: 'Archive',
  delete: 'Delete',
  mark_read: 'Mark read',
  complete: 'Complete',
  reviewed: 'Reviewed',
  dismiss: 'Dismiss',
  snooze: 'Snooze',
  reply: 'Reply',
  open: 'Open',
  gary: 'Hand to __AGENT_NAME__',
};

export function actionLabel(action) {
  const k = String(action || '').toLowerCase();
  if (ACTION_LABEL[k]) return ACTION_LABEL[k];
  const words = k.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

// The verb (if any) that "clears" an item from the feed for a given source.
// This becomes the card's primary button. dismiss/snooze are universal and
// never primary; dismiss is rendered as the ✕, snooze/open/gary as affordances.
const CLEAR_VERBS = ['add_asana', 'archive', 'mark_read', 'complete', 'reviewed'];

// Produce the ordered button descriptors a card should render.
// role: 'primary' (the clear-action), 'ghost' (secondary verbs like delete),
//       'x' (dismiss → the ✕), 'icon' (snooze / open / gary affordances).
// A calendar invite awaiting a Yes/Maybe/No. Detected by source, the backend
// `rsvp` action, or the meta.isInvite flag — any one is enough.
export function isInvite(item) {
  const allowed = Array.isArray(item && item.actions)
    ? item.actions.map((a) => String(a).toLowerCase()) : [];
  return (item && item.source === 'calendar')
    || allowed.includes('rsvp')
    || !!(item && item.meta && item.meta.isInvite);
}

export function cardActions(item) {
  const allowed = Array.isArray(item && item.actions) ? item.actions.map((a) => String(a).toLowerCase()) : [];

  // Calendar invite: Yes / Maybe / No write the RSVP straight to Google. There
  // is no "clear verb" — the three responses ARE the actions. Dismiss stays the
  // top-right ✕; open/snooze/gary remain as universal affordances.
  if (isInvite(item)) {
    return [
      { action: 'rsvpYes', label: 'Yes', role: 'primary' },
      { action: 'rsvpMaybe', label: 'Maybe', role: 'ghost' },
      { action: 'rsvpNo', label: 'No', role: 'ghost' },
      { action: 'open', label: actionLabel('open'), role: 'icon' },
      { action: 'snooze', label: actionLabel('snooze'), role: 'icon' },
      { action: 'gary', label: actionLabel('gary'), role: 'icon' },
    ];
  }

  const out = [];

  // Primary clear-action: first allowed verb that clears the item.
  const primary = CLEAR_VERBS.find((v) => allowed.includes(v));
  if (primary) out.push({ action: primary, label: actionLabel(primary), role: 'primary' });

  // Remaining clear-ish verbs (e.g. gmail delete, obsidian complete/reviewed)
  // move to the ⋯ overflow so the main row stays invariant across sources.
  const overflow = [];
  for (const v of allowed) {
    if (v === primary || v === 'dismiss' || v === 'snooze') continue;
    if (out.some((a) => a.action === v) || overflow.some((a) => a.action === v)) continue;
    overflow.push({ action: v, label: actionLabel(v), role: 'overflow' });
  }

  // Universal affordances, always offered regardless of the backend list.
  out.push({ action: 'open', label: actionLabel('open'), role: 'icon' });
  if (allowed.includes('snooze') || !allowed.length) {
    out.push({ action: 'snooze', label: actionLabel('snooze'), role: 'icon' });
  }
  out.push({ action: 'gary', label: actionLabel('gary'), role: 'icon' });
  // Dismiss is NOT a row button — it lives as the top-right ✕ on the card
  // (`.top .inbox-x` in surfaces.js), so we don't duplicate it in the action row.

  out.push(...overflow);
  return out;
}

// Visible-feed derivation: hide dismissed ids, apply an optional source filter.
// filter is an uppercased src tag (e.g. 'GMAIL') or null/undefined for all.
export function filterVisible(items, opts) {
  const list = Array.isArray(items) ? items : [];
  const dismissed = (opts && opts.dismissed) || [];
  const filter = (opts && opts.filter) || null;
  return list.filter((m) => {
    if (dismissed.includes(String(m.id))) return false;
    if (filter && String(m.src).toUpperCase() !== String(filter).toUpperCase()) return false;
    return true;
  });
}

// Counts for the chip row. Prefer the backend `sources` map (authoritative
// totals across the whole feed, not just what's loaded); fall back to counting
// the currently-visible items by src. `all` is always the visible length.
export function sourceCounts(items, opts, backendSources) {
  const visible = filterVisible(items, { dismissed: (opts && opts.dismissed) || [], filter: null });
  const counts = { all: visible.length };
  if (backendSources && typeof backendSources === 'object') {
    for (const [src, n] of Object.entries(backendSources)) {
      counts[String(src).toUpperCase()] = n;
    }
  } else {
    for (const m of visible) {
      const k = String(m.src).toUpperCase();
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

// Synchronous click-out URL. Returns the backend-provided deep link when
// present. Gmail lacks a Message-ID in the envelope, so it resolves lazily via
// the email reader elsewhere — here it returns null.
export function openUrlFor(item) {
  return (item && item.meta && item.meta.url) || null;
}

// Chip-row color dots, one per known source.
const CHIP_DOT = { GMAIL: 'var(--red)', SLACK: 'var(--green)', ASANA: 'var(--gold)',
  OBSIDIAN: 'var(--purple, #b794f6)', DOCUMENTS: 'var(--blue, #6aa6f0)',
  CALENDAR: 'var(--teal, #45d3c7)' };

export function chipRowHtml(counts, opts, esc) {
  const filter = (opts && opts.filter) || null;
  const errors = (opts && opts.errors) || {};
  const errUp = {}; for (const k of Object.keys(errors)) errUp[k.toUpperCase()] = true;
  const chip = (key, label, n) => {
    const active = (key === 'ALL' && !filter) || key === filter;
    const dot = key === 'ALL' ? '' : `<span class="dot" style="background:${CHIP_DOT[key] || 'var(--muted)'}"></span>`;
    const warn = errUp[key] ? ' <span class="chip-warn" title="source error">⚠</span>' : '';
    return `<span class="src-chip${active ? ' active' : ''}" data-act="setFilter" data-arg="${key}">${dot}${esc(label)} ${n || 0}${warn}</span>`;
  };
  const order = ['GMAIL', 'SLACK', 'ASANA', 'OBSIDIAN', 'DOCUMENTS', 'CALENDAR'];
  const present = order.filter((k) => k in counts || errUp[k]);
  return `<div class="src-chips">${chip('ALL', 'All', counts.all)}${present.map((k) => chip(k, k.toLowerCase(), counts[k])).join('')}</div>`;
}

// Render the ordered action row for a card. `esc` is the caller's HTML-escaper.
// primary → solid btn; ghost → ghost btn; icon → small affordance; x → the ✕.
export function cardButtonsHtml(item, esc, opts) {
  const id = esc(String(item && item.id));
  const moreOpen = !!(opts && opts.moreOpen);
  const acts = cardActions(item);
  const overflow = acts.filter((b) => b.role === 'overflow');
  const btns = acts.filter((b) => b.role !== 'overflow').map((b) => {
    if (b.role === 'x') {
      return `<button class="inbox-x" data-act="dismiss" data-arg="${id}" title="Dismiss">✕</button>`;
    }
    if (b.role === 'icon') {
      const glyph = b.action === 'open' ? '↗' : b.action === 'snooze' ? '⏰' : '🤖';
      return `<button class="ic-btn" data-act="${esc(b.action)}" data-arg="${id}" title="${esc(b.label)}">${glyph}</button>`;
    }
    const cls = b.role === 'primary' ? 'btn-sm' : 'btn-sm ghost';
    return `<button class="${cls}" data-act="${esc(b.action)}" data-arg="${id}">${esc(b.label)}</button>`;
  });
  if (overflow.length) {
    btns.push(`<button class="ic-btn more-btn" data-act="toggleMore" data-arg="${id}" title="More">⋯</button>`);
  }
  let overflowHtml = '';
  if (overflow.length && moreOpen) {
    const items = overflow.map((b) =>
      `<button class="btn-sm ghost" data-act="${esc(b.action)}" data-arg="${id}">${esc(b.label)}</button>`).join('');
    overflowHtml = `<div class="card-overflow">${items}</div>`;
  }
  return `<div class="card-actions">${btns.join('')}</div>${overflowHtml}`;
}

// --- snoozeUntilMs: maps a snooze preset to an absolute epoch-ms value ------
// Pure helper — takes nowMs so it's deterministic/testable.
// Presets: later = +4h; tomorrow = next calendar day 09:00 UTC;
//          nextweek = +7 calendar days 09:00 UTC.
export function snoozeUntilMs(preset, nowMs) {
  const p = String(preset || '').toLowerCase();
  if (p === 'later') return nowMs + 4 * 3600000;
  const d = new Date(nowMs);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (p === 'tomorrow') {
    const day = d.getUTCDate() + 1;
    return Date.UTC(y, m, day, 9, 0, 0);
  }
  if (p === 'nextweek') {
    const day = d.getUTCDate() + 7;
    return Date.UTC(y, m, day, 9, 0, 0);
  }
  return nowMs + 4 * 3600000; // fallback to later
}

// --- swipeIntent: classify a horizontal swipe gesture for mobile cards ------
// dx > 0 = right-swipe (primary action); dx < 0 = left-swipe (snooze/dismiss).
// width param is available for future proportional thresholds; fixed px used now.
// Returns 'primary' | 'snooze' | 'dismiss' | null.
export function swipeIntent(dx, width) { // eslint-disable-line no-unused-vars
  if (dx > 84)  return 'primary';
  if (dx < -140) return 'snooze';
  if (dx < -84)  return 'dismiss';
  return null;
}

// --- dueChipToISO: maps Add-to-Asana date chips to ISO YYYY-MM-DD ----------
// Pure helper — takes nowMs so it's deterministic/testable regardless of TZ.
// Chips: today | tomorrow | fri | nextweek | none (anything else → null).
function _iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
const DAY = 86400000;
export function dueChipToISO(chip, nowMs) {
  const c = String(chip || '').toLowerCase();
  const d = new Date(nowMs);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  if (c === 'none') return null;
  if (c === 'today') return _iso(nowMs);
  if (c === 'tomorrow') return _iso(nowMs + DAY);
  if (c === 'fri') { let add = (5 - dow + 7) % 7; if (add === 0) add = 7; return _iso(nowMs + add * DAY); }
  if (c === 'nextweek') { const add = ((1 - dow + 7) % 7) || 7; return _iso(nowMs + add * DAY); }
  return null;
}
