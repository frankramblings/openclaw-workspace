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
// grid AND the agenda window (today..today+8) so browsing other months
// never empties the mobile agenda. Grid size is dynamic: ceil((leadingBlanks +
// daysInMonth)/7)*7 cells to ensure all month days fit in complete weeks.
export function monthWindow(real, offset) {
  const off = Math.trunc(Number(offset) || 0);
  const today = new Date(real.getFullYear(), real.getMonth(), real.getDate());
  const first = new Date(real.getFullYear(), real.getMonth() + off, 1);
  const gridStart = addDays(first, -monIdx(first)); // back up to Monday

  // Calculate dynamic grid size: leading blanks + days in month, rounded to complete weeks
  const leadingBlanks = monIdx(first);
  const nextMonth = new Date(real.getFullYear(), real.getMonth() + off + 1, 1);
  const daysInMonth = (nextMonth - first) / (1000 * 60 * 60 * 24);
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;
  const gridEnd = addDays(gridStart, totalCells - 1); // totalCells inclusive

  const agendaEnd = addDays(today, 8);
  const fetchStart = gridStart < today ? gridStart : today;
  const gridPastEnd = addDays(gridEnd, 1);
  const fetchEnd = gridPastEnd > agendaEnd ? gridPastEnd : agendaEnd;
  return { today, first, gridStart, gridEnd, fetchStart, fetchEnd };
}
