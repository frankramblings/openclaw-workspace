// Live wiring for the CALENDAR surface. Populates state.live.calendar in the
// mock's shape (see data.js CAL_CELLS/CAL_MONTH and mobile-data.js
// WEEK_STRIP/AGENDA). Desktop month grid + mobile agenda share this state.
// Fails soft: if the events fetch throws, load() throws and the render keeps
// the mock.
//
// Shape produced:
//   state.live.calendar = {
//     cells:   [{ date, dim?, today?, last?, bars?:[{label,tone}],
//                 events?:[{label,dot,faded?}], more? }]  (35, Mon-start),
//     month:   'June 2026',
//     week:    [{ d:'M'|'T'|..., date, today? }]          (current week, Mon-start),
//     agenda:  [{ label, tag?, tagColor?, events:[{time,tone,title,sub?}] }]
//   }
//
// Backend (same-origin, no auth):
//   GET  /api/calendar/events?start=YYYY-MM-DD&end=YYYY-MM-DD
//        -> { events:[{uid, summary, dtstart, dtend, all_day, location, color, calendar}] }
//        dtstart/dtend are 'YYYY-MM-DD' when all_day (end EXCLUSIVE), else ISO.
//   GET  /api/calendar/calendars -> { calendars:[{href,name,color,hex,primary}] }
//   POST /api/calendar/quick-parse {text, tz} -> bare event dict (NOT {ok,event})
//   POST /api/calendar/events <event dict>

import { runtime } from './runtime.js';
import { apiGet, apiJson } from './api.js';
import { reload } from './index.js';

const TZ = 'America/New_York';
const DOTS = {
  teal: 'var(--teal)', blue: 'var(--blue)', gold: 'var(--gold)',
  violet: 'var(--violet)', green: 'var(--green)',
};
const TONES = ['blue', 'green', 'violet', 'gold']; // bar tone palette (no teal)

// ---- date helpers (all in browser-local time) -----------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // Sun-indexed single letters

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayKey(d) { return ymd(d); }
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
// Monday-start weekday index: Mon=0 .. Sun=6
function monIdx(d) { return (d.getDay() + 6) % 7; }

// Parse an all-day 'YYYY-MM-DD' as a local date (avoid UTC shift).
function parseAllDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function parseTimed(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function hhmm(d) {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
// agenda uses 'h:mm' (no leading zero on hour, as in the mock '9:00'/'08:15'
// mix — we follow the bare-hour convention used by the live timed labels).
function agendaTime(d) {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// ---- color mapping --------------------------------------------------------

// Map a hex color to one of our five named buckets.
function bucketFromHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 28) return null; // too gray to classify confidently
  if (r >= g && r >= b) {
    // reddish/brown -> treat warm as gold
    return 'gold';
  }
  if (g >= r && g >= b) {
    // green vs teal: teal has notable blue too
    return b > r + 30 ? 'teal' : 'green';
  }
  // blue dominant: violet if red is also high
  return r > 110 ? 'violet' : 'blue';
}

function bucketFromName(name) {
  const s = (name || '').toLowerCase();
  if (/holiday|travel|trip|pto|ooo|vacation|birthday|anniv/.test(s)) return 'gold';
  if (/personal|home|family/.test(s)) return 'teal';
  if (/market|brand|content/.test(s)) return 'violet';
  if (/wist|company|all.?hands|wide|events/.test(s)) return 'blue';
  return null;
}

// Resolve a named bucket for an event using its color, then calendar color,
// then calendar/summary name. Returns one of teal/blue/gold/violet/green.
function bucketOf(ev, calColors) {
  return bucketFromHex(ev.color)
    || bucketFromHex(calColors[ev.calendar])
    || bucketFromName(ev.calendar)
    || bucketFromName(ev.summary)
    || 'teal';
}

function colorVar(ev, calColors) { return DOTS[bucketOf(ev, calColors)] || DOTS.teal; }
// Bars have no teal tone; collapse teal -> blue for the bar palette.
function toneOf(ev, calColors) {
  const b = bucketOf(ev, calColors);
  return TONES.includes(b) ? b : 'blue';
}

// ---- event classification -------------------------------------------------

// Expand an event into the set of local day-keys it occupies, plus whether it
// is an all-day/multi-day "bar" event. all_day end dates are EXCLUSIVE.
function eventDays(ev) {
  if (ev.all_day) {
    const s = parseAllDay(ev.dtstart);
    let e = parseAllDay(ev.dtend) || s;
    if (!s) return { bar: true, days: [], start: null };
    // exclusive end: subtract a day so a 1-day event covers only its start
    e = addDays(e, -1);
    if (e < s) e = s;
    const days = [];
    for (let d = s; d <= e; d = addDays(d, 1)) days.push(dayKey(d));
    return { bar: true, days, start: s };
  }
  const s = parseTimed(ev.dtstart);
  const e = parseTimed(ev.dtend) || s;
  if (!s) return { bar: false, days: [], start: null };
  // A timed event spanning multiple calendar days (>=24h block) -> bar.
  const sKey = dayKey(s);
  const eKey = dayKey(e);
  if (sKey !== eKey) {
    const days = [];
    for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); dayKey(d) <= eKey; d = addDays(d, 1)) days.push(dayKey(d));
    return { bar: true, days, start: s };
  }
  return { bar: false, days: [sKey], start: s };
}

// ---- main load ------------------------------------------------------------

export async function load(state /* , { force } = {} */) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = dayKey(today);

  // Grid: Monday-start, 35 cells covering the current month.
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const gridStart = addDays(first, -monIdx(first)); // back up to Monday
  const gridEnd = addDays(gridStart, 34);           // 35 cells inclusive

  // Fetch a buffer covering both the grid and the agenda window (today+6d).
  const fetchStart = gridStart;
  const fetchEnd = addDays(gridEnd, 1) > addDays(today, 8) ? addDays(gridEnd, 1) : addDays(today, 8);

  // calendars (best-effort: color/name lookup). Never fatal.
  let calColors = {};   // href -> hex
  const calNames = {};  // href -> friendly display name
  try {
    const c = await apiGet('/api/calendar/calendars');
    for (const cal of (c?.calendars || [])) {
      if (!cal.href) continue;
      calColors[cal.href] = cal.hex || cal.color;
      if (cal.name) calNames[cal.href] = cal.name;
    }
  } catch (_) { /* keep empty maps */ }
  // Friendly calendar label for an event's `sub` (name, then href, then '').
  const calLabel = (ev) => calNames[ev.calendar] || ev.calendar || '';

  // events — fatal on failure so the loader keeps the mock.
  const raw = await apiGet(`/api/calendar/events?start=${ymd(fetchStart)}&end=${ymd(fetchEnd)}`);
  const events = Array.isArray(raw?.events) ? raw.events : [];

  // Index events by local day-key.
  const byDay = new Map();   // key -> { bars:[], timed:[{when, ev}] }
  for (const ev of events) {
    if (!ev || !ev.summary && ev.summary !== '') continue;
    const info = eventDays(ev);
    for (const k of info.days) {
      let slot = byDay.get(k);
      if (!slot) { slot = { bars: [], timed: [] }; byDay.set(k, slot); }
      if (info.bar) slot.bars.push(ev);
      else slot.timed.push({ when: info.start, ev });
    }
  }
  for (const slot of byDay.values()) slot.timed.sort((a, b) => a.when - b.when);

  // ---- desktop cells ----
  const cells = [];
  for (let i = 0; i < 35; i++) {
    const d = addDays(gridStart, i);
    const k = dayKey(d);
    const slot = byDay.get(k);
    const cell = { date: d.getDate() };
    if (d.getMonth() !== now.getMonth()) cell.dim = true;
    if (k === todayKey) cell.today = true;
    if (monIdx(d) === 6) cell.last = true; // Sunday column = no right border

    let used = 0;        // visible rows
    const cap = 2;       // ~2 visible per cell
    let total = 0;

    if (slot) {
      const bars = [];
      for (const ev of slot.bars) {
        total++;
        if (used < cap) { bars.push({ label: ev.summary || '', tone: toneOf(ev, calColors) }); used++; }
      }
      if (bars.length) cell.bars = bars;

      const evs = [];
      for (const t of slot.timed) {
        total++;
        if (used < cap) {
          const time = hhmm(t.when);
          const label = t.ev.summary ? `${time} ${t.ev.summary}` : time;
          const e = { label, dot: colorVar(t.ev, calColors) };
          if (cell.dim) e.faded = true;
          evs.push(e);
          used++;
        }
      }
      if (evs.length) cell.events = evs;

      const hidden = total - used;
      if (hidden > 0) cell.more = `+${hidden} more`;
    }
    if (!cell.bars && !cell.events) cell.events = [];
    cells.push(cell);
  }

  const month = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  // ---- mobile week strip (current week, Monday-start) ----
  const weekStart = addDays(today, -monIdx(today));
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const w = { d: DOW1[d.getDay()], date: d.getDate() };
    if (dayKey(d) === todayKey) w.today = true;
    week.push(w);
  }

  // ---- mobile agenda (today + next ~6 days, only days with events) ----
  const dowFull = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const monAbbr = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const agenda = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    const k = dayKey(d);
    const slot = byDay.get(k);
    if (!slot || (!slot.bars.length && !slot.timed.length)) continue;

    const dateLabel = `${dowFull[d.getDay()]} ${monAbbr[d.getMonth()]} ${d.getDate()}`;
    const isToday = k === todayKey;
    const group = { label: isToday ? `TODAY · ${dateLabel}` : `${dowFull[d.getDay()]} · ${monAbbr[d.getMonth()]} ${d.getDate()}`, events: [] };

    // First all-day/bar can become the day's tag.
    if (slot.bars.length) {
      const tagEv = slot.bars[0];
      group.tag = tagEv.summary || undefined;
      if (group.tag) group.tagColor = colorVar(tagEv, calColors);
    }

    for (const ev of slot.bars) {
      const sub = ev.location || calLabel(ev);
      group.events.push({
        time: 'all-day',
        tone: colorVar(ev, calColors),
        title: ev.summary || '(busy)',
        ...(sub ? { sub } : {}),
      });
    }
    for (const t of slot.timed) {
      const sub = t.ev.location || calLabel(t.ev);
      group.events.push({
        time: agendaTime(t.when),
        tone: colorVar(t.ev, calColors),
        title: t.ev.summary || '(busy)',
        ...(sub ? { sub } : {}),
      });
    }
    agenda.push(group);
  }

  state.live.calendar = { cells, month, week, agenda };
}

// ---- optional quick-add action --------------------------------------------
// Override the mock's clearQuick to actually create an event from the quick-add
// box. Robust/optional: any failure just clears the box and re-renders so the
// UI never gets stuck. quick-parse returns a BARE event dict (NOT {ok,event}).

export const actions = {
  // Calendar header "+ New": focus the natural-language quick-add (the create path).
  newEvent: () => {
    try {
      setTimeout(() => {
        const el = document.querySelector('[data-focus="quick"]');
        if (el && el.focus) { el.focus(); try { el.select(); } catch (_) {} }
      }, 0);
    } catch (_) {}
  },

  clearQuick: async () => {
    const state = runtime.state;
    const text = (state?.quick || '').trim();
    if (!text) { if (state) state.quick = ''; runtime.render(); return; }
    try {
      const parsed = await apiJson('/api/calendar/quick-parse', { text, tz: TZ });
      // bare event dict; bail soft if the parser was unavailable / shapeless.
      if (parsed && !parsed.error && (parsed.dtstart || parsed.summary)) {
        await apiJson('/api/calendar/events', parsed);
      }
    } catch (_) {
      // swallow — clearing + reload below keeps the UI consistent.
    } finally {
      if (state) state.quick = '';
      runtime.render();
      try { reload('calendar'); } catch (_) {}
    }
  },
};
