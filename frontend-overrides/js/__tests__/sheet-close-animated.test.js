import { test } from 'node:test';
import assert from 'node:assert';
import { startClosingSheet } from '../redesign/mobile/sheet-close.js';

test('marks the closing flag true without touching the open flag yet', () => {
  const state = { companionSheetOpen: true, companionSheetClosing: false };
  startClosingSheet(state, 'companionSheetOpen', 'companionSheetClosing');
  assert.equal(state.companionSheetOpen, true);   // still renders during the exit animation
  assert.equal(state.companionSheetClosing, true);
});

test('a second call while already closing is a no-op (does not re-arm)', () => {
  const state = { companionSheetOpen: true, companionSheetClosing: true };
  const before = { ...state };
  startClosingSheet(state, 'companionSheetOpen', 'companionSheetClosing');
  assert.deepEqual(state, before);
});

test('a call when the sheet is not open is a no-op (nothing to close)', () => {
  const state = { companionSheetOpen: false, companionSheetClosing: false };
  startClosingSheet(state, 'companionSheetOpen', 'companionSheetClosing');
  assert.equal(state.companionSheetClosing, false);
});
