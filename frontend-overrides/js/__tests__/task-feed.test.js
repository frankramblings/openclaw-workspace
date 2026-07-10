import { test } from 'node:test';
import assert from 'node:assert';
import { reduceFeedEvent, nextBackoff, pruneTerminal, shouldApplyFallback } from '../redesign/live/task-feed.js';

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
  const m = new Map([
    ['a', { id: 'a', state: 'done', updated: 1000 }],
    ['b', { id: 'b', state: 'running', updated: 1000 }],
    ['c', { id: 'c', state: 'failed', updated: 90_000 }],
  ]);
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
