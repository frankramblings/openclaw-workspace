// Must be set before any Date is constructed (in this file or in the module
// under test) so DST transitions are exercised deterministically regardless
// of the host machine's local timezone. Works on Linux Node.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert';
import { monthWindow, addDays, monIdx } from '../redesign/live/calendar-logic.js';

// Helper: count days from gridStart to gridEnd (inclusive) to verify grid size
function gridCellCount(gridStart, gridEnd) {
  const diffMs = gridEnd - gridStart;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return diffDays + 1;
}

// Helper: check if a date is within the grid window
function isInGrid(date, gridStart, gridEnd) {
  return date >= gridStart && date <= gridEnd;
}

test('Aug 2026 grid includes Aug 31 (6-row month)', () => {
  const real = new Date(2026, 6, 10); // Jul 10 2026
  const w = monthWindow(real, 1); // August 2026

  // August 2026 has 31 days, starting on Saturday (monIdx=5)
  // Leading blanks: 5 (Mon, Tue, Wed, Thu, Fri)
  // Total cells needed: ceil((5 + 31) / 7) * 7 = ceil(36/7) * 7 = 6 * 7 = 42
  const aug31 = new Date(2026, 7, 31);
  assert.ok(isInGrid(aug31, w.gridStart, w.gridEnd), 'Aug 31 should be in grid window');

  const cellCount = gridCellCount(w.gridStart, w.gridEnd);
  assert.equal(cellCount, 42, 'Aug 2026 grid should have 42 cells (6 rows)');
});

test('Nov 2026 grid includes Nov 30 (6-row month)', () => {
  const real = new Date(2026, 6, 10); // Jul 10 2026
  const w = monthWindow(real, 4); // November 2026

  // November 2026 has 30 days, starting on Sunday (monIdx=6)
  // Leading blanks: 6 (Mon-Sat)
  // Total cells needed: ceil((6 + 30) / 7) * 7 = ceil(36/7) * 7 = 6 * 7 = 42
  const nov30 = new Date(2026, 10, 30);
  assert.ok(isInGrid(nov30, w.gridStart, w.gridEnd), 'Nov 30 should be in grid window');

  const cellCount = gridCellCount(w.gridStart, w.gridEnd);
  assert.equal(cellCount, 42, 'Nov 2026 grid should have 42 cells (6 rows)');
});

test('Feb 2024 Thursday-start month uses exactly 35 cells', () => {
  // Feb 2024: 29 days (leap year), starts on Thursday (monIdx=3)
  const real = new Date(2024, 0, 15); // Jan 2024
  const w = monthWindow(real, 1); // February 2024

  // Leading blanks: 3
  // Total cells needed: ceil((3 + 29) / 7) * 7 = ceil(32/7) * 7 = 5 * 7 = 35
  const cellCount = gridCellCount(w.gridStart, w.gridEnd);
  assert.equal(cellCount, 35, `Feb 2024 grid should have exactly 35 cells, got ${cellCount}`);
});

test('Feb 2032 Monday-start month uses correct grid size', () => {
  // Feb 2032: 29 days (leap year), starts on Sunday (monIdx=6)
  const real = new Date(2032, 0, 15);
  const w = monthWindow(real, 1); // February 2032

  // Leading blanks: 6 (Mon-Sat)
  // Total cells needed: ceil((6 + 29) / 7) * 7 = ceil(35/7) * 7 = 5 * 7 = 35
  const cellCount = gridCellCount(w.gridStart, w.gridEnd);
  assert.equal(cellCount, 35, 'Feb 2032 grid should have 35 cells (5 rows)');
});

test('March 2025 (31-day month starting Saturday) uses 42 cells', () => {
  // March 2025: 31 days, starts on Saturday (monIdx=5)
  const real = new Date(2025, 1, 15);
  const w = monthWindow(real, 1); // March 2025

  // Leading blanks: 5 (Mon-Sat)
  // Total cells needed: ceil((5 + 31) / 7) * 7 = ceil(36/7) * 7 = 6 * 7 = 42
  const cellCount = gridCellCount(w.gridStart, w.gridEnd);
  assert.equal(cellCount, 42, 'March 2025 grid should have 42 cells (6 rows)');
});

test('Nov 2025 (DST fall-back inside month) uses exactly 35 cells', () => {
  // Nov 2025: 30 days, starts on Saturday (monIdx=5). US DST ends (clocks fall
  // back) on Nov 2, 2025 — inside this month. A buggy daysInMonth computed as
  // (nextMonth - first) / 86400000 measures wall-clock ms, not calendar days,
  // so it comes out to 30.0417 instead of 30, which pushes
  // ceil((5 + 30.0417) / 7) * 7 up to 42 instead of the correct 35.
  const real = new Date(2025, 9, 15); // Oct 2025
  const w = monthWindow(real, 1); // November 2025

  // Leading blanks: 5 (Mon-Sat)
  // Total cells needed: ceil((5 + 30) / 7) * 7 = ceil(35/7) * 7 = 5 * 7 = 35
  const cellCount = gridCellCount(w.gridStart, w.gridEnd);
  assert.equal(cellCount, 35, `Nov 2025 grid should have exactly 35 cells, got ${cellCount}`);
});
