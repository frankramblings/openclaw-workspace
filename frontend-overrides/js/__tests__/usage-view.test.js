import { test } from 'node:test';
import assert from 'node:assert';
import { fmtTokens, usageLine, usageTitle, sessionTotalsLine } from '../redesign/usage-view.js';

test('fmtTokens', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(842), '842');
  assert.equal(fmtTokens(12345), '12.3k');
  assert.equal(fmtTokens(1234567), '1.2M');
  assert.equal(fmtTokens(null), '0');
});

test('usageLine with and without ctx', () => {
  assert.equal(usageLine({ input: 12345, output: 1100 }, 41), '↑12.3k ↓1.1k · 41% ctx');
  assert.equal(usageLine({ input: 12345, output: 1100 }, null), '↑12.3k ↓1.1k');
  assert.equal(usageLine({ input: 0, output: 0 }, 41), '');
  assert.equal(usageLine(null, 41), '');
});

test('usageTitle lists all four with thousands separators', () => {
  assert.equal(usageTitle({ input: 12345, output: 1100, cacheRead: 900, cacheWrite: 0 }),
    'input 12,345 · output 1,100 · cache read 900 · cache write 0');
});

test('sessionTotalsLine hides dollars unless costed', () => {
  const t = { input: 1200000, output: 84000, totalCost: 1.234 };
  assert.equal(sessionTotalsLine(t, false), 'Session: ↑1.2M ↓84k');
  assert.equal(sessionTotalsLine(t, true), 'Session: ↑1.2M ↓84k · $1.23');
  assert.equal(sessionTotalsLine(null, true), '');
});
