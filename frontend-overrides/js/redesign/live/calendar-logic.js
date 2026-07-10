// Pure month-window math for the calendar surface — no DOM, no fetch, so it
// stays importable in Node tests (live/calendar.js pulls in api.js which needs
// `location`). calendar.js consumes monthWindow(); calPrev/calNext/calToday
// drive the offset.

export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

// Monday-start weekday index: Mon=0 .. Sun=6
export function monIdx(d) { return (d.getDay() + 6) % 7; }

// The rendered window for a given real "now" and a view offset in months.
// `today` stays anchored to the real date (today highlight + agenda); `first`
// is the 1st of the viewed month. The fetch range always covers both the
// 35-cell grid AND the agenda window (today..today+8) so browsing other
// months never empties the mobile agenda.
export function monthWindow(real, offset) {
  const off = Math.trunc(Number(offset) || 0);
  const today = new Date(real.getFullYear(), real.getMonth(), real.getDate());
  const first = new Date(real.getFullYear(), real.getMonth() + off, 1);
  const gridStart = addDays(first, -monIdx(first)); // back up to Monday
  const gridEnd = addDays(gridStart, 34);           // 35 cells inclusive
  const agendaEnd = addDays(today, 8);
  const fetchStart = gridStart < today ? gridStart : today;
  const gridPastEnd = addDays(gridEnd, 1);
  const fetchEnd = gridPastEnd > agendaEnd ? gridPastEnd : agendaEnd;
  return { today, first, gridStart, gridEnd, fetchStart, fetchEnd };
}
