import { test } from 'node:test';
import assert from 'node:assert';
import { closeAnimMs } from '../redesign/mobile/sheet-close.js';

test('normal motion: returns the full 200ms close-animation duration', () => {
  assert.equal(closeAnimMs(false), 200);
});

test('reduced motion: returns 0 so the sheet unmounts as soon as it visually vanishes', () => {
  assert.equal(closeAnimMs(true), 0);
});
