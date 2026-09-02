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

// --- Fix round: claude-cli reports placeholder input/output ---------------
// Its real prompt volume sits in cacheRead/cacheWrite, so the up-arrow is the
// prompt-side total and the down-arrow is dropped (no fake "↓1").

test('claude-cli: up-arrow is input + cacheRead + cacheWrite, no down-arrow', () => {
  const u = { input: 2, output: 1, cacheRead: 80000, cacheWrite: 1060 };
  assert.equal(usageLine(u, null, { provider: 'claude-cli' }), '↑81.1k');
  assert.equal(usageLine(u, 41, { provider: 'claude-cli' }), '↑81.1k · 41% ctx');
});

test('other providers keep both arrows and the same prompt-side arithmetic', () => {
  const u = { input: 2, output: 1200, cacheRead: 80000, cacheWrite: 1060 };
  assert.equal(usageLine(u, null, { provider: 'openai' }), '↑81.1k ↓1.2k');
  assert.equal(usageLine(u, null), '↑81.1k ↓1.2k');
});

test('a wholly empty record still renders nothing', () => {
  assert.equal(usageLine({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 41, { provider: 'claude-cli' }), '');
});

test('usageTitle keeps the raw four and flags the missing claude-cli output', () => {
  const u = { input: 2, output: 1, cacheRead: 80000, cacheWrite: 1060 };
  assert.equal(usageTitle(u, { provider: 'claude-cli' }),
    'input 2 · output 1 · cache read 80,000 · cache write 1,060 · output not reported by claude-cli');
  assert.ok(!usageTitle(u, { provider: 'openai' }).includes('not reported'));
});

test('sessionTotalsLine follows the same arithmetic and omission rule', () => {
  const t = { input: 2, output: 1, cacheRead: 1200000, cacheWrite: 0, totalCost: 1.234 };
  assert.equal(sessionTotalsLine(t, false, { provider: 'claude-cli' }), 'Session: ↑1.2M');
  assert.equal(sessionTotalsLine(t, true, { provider: 'openai' }), 'Session: ↑1.2M ↓1 · $1.23');
});
