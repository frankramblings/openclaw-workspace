import { test } from 'node:test';
import assert from 'node:assert';
import { reduceFeedEvent, nextBackoff, pruneTerminal, shouldApplyFallback } from '../redesign/live/task-feed.js';
import { markSeen, TERMINAL_FOREGROUND_MS } from '../redesign/live/task-feed.js';

const t = (id, state = 'running', extra = {}) => ({ id, state, updated: 1, ...extra });

test('snapshot rebuilds the map', () => {
  let m = new Map([['stale:1', t('stale:1')]]);
  m = reduceFeedEvent(m, { type: 'tasks.snapshot', tasks: [t('job:a'), t('job:b')] });
  assert.deepEqual([...m.keys()], ['job:a', 'job:b']);
});

test('update merges one task', () => {
  let m = new Map();
  m = reduceFeedEvent(m, { type: 'task.update', task: t('job:a', 'running', { pct: 10 }) });
  m = reduceFeedEvent(m, { type: 'task.update', task: t('job:a', 'running', { pct: 60 }) });
  assert.equal(m.get('job:a').pct, 60);
  assert.equal(m.size, 1);
});

test('unknown event types are ignored', () => {
  const m0 = new Map([['job:a', t('job:a')]]);
  const m1 = reduceFeedEvent(m0, { type: 'mystery' });
  assert.deepEqual([...m1.keys()], ['job:a']);
});

test('backoff doubles to a 15s cap with a 1s floor', () => {
  assert.equal(nextBackoff(0), 1000);
  assert.equal(nextBackoff(1000), 2000);
  assert.equal(nextBackoff(8000), 15000);
  assert.equal(nextBackoff(15000), 15000);
});

test('pruneTerminal drops old terminal records, keeps running + fresh', () => {
  // 'a' is seen (foreground) early; 'c' is seen much later — pruneTerminal now
  // measures budget from _fgSeen, not from the server's `updated` stamp.
  // markSeen only stamps rows that don't have _fgSeen yet, so 'c' is added
  // (and thus stamped) in a separate pass after 'a' is already marked.
  let m = new Map([['a', { id: 'a', state: 'done', updated: 1000 }]]);
  m = markSeen(m, 1000, true);
  m.set('b', { id: 'b', state: 'running', updated: 1000 });
  m.set('c', { id: 'c', state: 'failed', updated: 90_000 });
  m = markSeen(m, 90_000, true);
  const out = pruneTerminal(m, 100_000, 60_000);
  assert.deepEqual([...out.keys()], ['b', 'c']);
});

test('pruneTerminal returns the SAME map when nothing to drop', () => {
  const m = new Map([['b', { id: 'b', state: 'running', updated: 0 }]]);
  assert.equal(pruneTerminal(m, 100_000, 60_000), m);
});

test('fallback snapshot is discarded while a stream is attached', () => {
  assert.equal(shouldApplyFallback(true), false);
  assert.equal(shouldApplyFallback(false), true);
});

test('a snapshot keeps terminal rows the server has already aged out', () => {
  // The phone was in a pocket for 3 minutes; the server pruned the finished
  // row at RETAIN_TERMINAL_S. Reconnecting must not delete it locally too.
  let m = new Map([['job:done', t('job:done', 'done')]]);
  m = reduceFeedEvent(m, { type: 'tasks.snapshot', tasks: [t('job:live')] });
  assert.deepEqual([...m.keys()].sort(), ['job:done', 'job:live']);
});

test('a snapshot still drops running rows it omits', () => {
  let m = new Map([['job:ghost', t('job:ghost', 'running')]]);
  m = reduceFeedEvent(m, { type: 'tasks.snapshot', tasks: [t('job:live')] });
  assert.deepEqual([...m.keys()], ['job:live']);
});

test('an unseen terminal row is never pruned, however long the wall clock runs', () => {
  const m = new Map([['job:done', t('job:done', 'done')]]);
  assert.equal(pruneTerminal(m, 10 * TERMINAL_FOREGROUND_MS).size, 1);
});

test('a terminal row is pruned only after the budget of FOREGROUND time', () => {
  let m = new Map([['job:done', t('job:done', 'done')]]);
  m = markSeen(m, 1000, true);
  assert.equal(pruneTerminal(m, 1000 + TERMINAL_FOREGROUND_MS - 1).size, 1);
  assert.equal(pruneTerminal(m, 1000 + TERMINAL_FOREGROUND_MS + 1).size, 0);
});

test('markSeen does nothing while the document is hidden', () => {
  let m = new Map([['job:done', t('job:done', 'done')]]);
  m = markSeen(m, 1000, false);
  assert.equal(m.get('job:done')._fgSeen, undefined);
});

test('markSeen ignores running rows', () => {
  let m = new Map([['job:run', t('job:run', 'running')]]);
  m = markSeen(m, 1000, true);
  assert.equal(m.get('job:run')._fgSeen, undefined);
});

// Fix round 1, F2: a snapshot (or task.update) that repeats an id the client
// already had must not reset that row's foreground budget — otherwise every
// app-switch resnapshot restarts the clock and a finished row rides the
// server's much longer RETAIN_TERMINAL_S instead of TERMINAL_FOREGROUND_MS.
test('a snapshot carries forward _fgSeen for a row it already knows, so the resumed budget is not refreshed', () => {
  let m = new Map([['job:done', t('job:done', 'done')]]);
  m = markSeen(m, 1000, true); // budget starts at fg=1000
  m = reduceFeedEvent(m, { type: 'tasks.snapshot', tasks: [t('job:done', 'done')] });
  assert.equal(m.get('job:done')._fgSeen, 1000, '_fgSeen carried forward, not reset by the snapshot');
  // Pruned on the ORIGINAL budget (from fg=1000) — a refreshed budget would
  // still show 1 row here since fg=1000+TERMINAL_FOREGROUND_MS is the seam.
  assert.equal(pruneTerminal(m, 1000 + TERMINAL_FOREGROUND_MS + 1).size, 0);
});

test('a task.update carries forward _fgSeen for a row it already knows, so the resumed budget is not refreshed', () => {
  let m = new Map([['job:done', t('job:done', 'done')]]);
  m = markSeen(m, 1000, true);
  m = reduceFeedEvent(m, { type: 'task.update', task: t('job:done', 'done', { detail: 'still done' }) });
  assert.equal(m.get('job:done')._fgSeen, 1000);
  assert.equal(pruneTerminal(m, 1000 + TERMINAL_FOREGROUND_MS + 1).size, 0);
});

test('a task.update that newly turns a row terminal has no stamp yet — markSeen still stamps it fresh (guard against over-fixing)', () => {
  let m = new Map([['job:x', t('job:x', 'running')]]);
  m = reduceFeedEvent(m, { type: 'task.update', task: t('job:x', 'done') });
  assert.equal(m.get('job:x')._fgSeen, undefined, 'reduceFeedEvent never stamps — only markSeen does');
  m = markSeen(m, 5000, true);
  assert.equal(m.get('job:x')._fgSeen, 5000);
});
