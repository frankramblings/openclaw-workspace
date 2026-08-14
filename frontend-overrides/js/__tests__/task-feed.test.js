import { test } from 'node:test';
import assert from 'node:assert';
import { reduceFeedEvent, nextBackoff, pruneTerminal, shouldApplyFallback } from '../redesign/live/task-feed.js';
import { markSeen, TERMINAL_FOREGROUND_MS, TOMBSTONE_MAX } from '../redesign/live/task-feed.js';

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

// FINAL review, critical 1. The backend retracts a live row when the merge
// attaches its producer to an observed row (task_registry.remove(notify=True)).
// Before this branch existed the client kept the orphan forever: only a full
// snapshot drops a running row the server omits, and snapshots arrive on
// connect and on a visibility resume, not per event.
test('a removal event drops the row', () => {
  let m = new Map([['taskfile:x', t('taskfile:x', 'running', { pct: 41 })],
    ['observed:200:20', t('observed:200:20')]]);
  m = reduceFeedEvent(m, { type: 'task.remove', id: 'taskfile:x' });
  assert.deepEqual([...m.keys()], ['observed:200:20']);
});

test('a removal event for an id we do not hold returns the SAME map', () => {
  const m = new Map([['job:a', t('job:a')]]);
  assert.equal(reduceFeedEvent(m, { type: 'task.remove', id: 'job:b' }), m);
});

test('a removal event with no id is ignored', () => {
  const m = new Map([['job:a', t('job:a')]]);
  assert.equal(reduceFeedEvent(m, { type: 'task.remove' }), m);
});

test('a removed id is not tombstoned — a new run under it must still appear', () => {
  const tombs = new Set();
  let m = new Map([['taskfile:nightly', t('taskfile:nightly', 'running')]]);
  m = reduceFeedEvent(m, { type: 'task.remove', id: 'taskfile:nightly' }, tombs);
  assert.equal(tombs.size, 0);
  m = reduceFeedEvent(m, { type: 'tasks.snapshot', tasks: [t('taskfile:nightly', 'running')] }, tombs);
  assert.deepEqual([...m.keys()], ['taskfile:nightly']);
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

// Fix round 2: F2's carry-forward must be gated on state IDENTITY, not just
// "was there a prior stamp". task_ingest.py deliberately revives an
// interrupted row to running when a producer's file postdates the death
// verdict — an unconditional carry-forward inherits the stale interrupted
// stamp onto the revived row, and since markSeen only stamps rows with
// _fgSeen == null, that stamp is never refreshed. The job later finishes
// carrying the ancient stamp and pruneTerminal deletes it before _notify's
// subscribers ever see the 'done' state — the row goes
// interrupted -> running -> vanished, never 'done'.
test('a row that revives from interrupted to running, then later finishes, gets its own fresh budget (not the stale interrupted stamp)', () => {
  let m = new Map([['job:x', t('job:x', 'interrupted')]]);
  m = markSeen(m, 1000, true); // stamped while interrupted, at fg=1000
  // Producer evidence revives it: task_ingest.py:117-128's honesty-runs-
  // both-directions rule. State changes, so the fg=1000 stamp must NOT
  // survive onto the revived row.
  m = reduceFeedEvent(m, { type: 'task.update', task: t('job:x', 'running') });
  assert.equal(m.get('job:x')._fgSeen, undefined, 'reviving to a new state drops the stale interrupted stamp');
  // Much later (fg=10x the budget), the job actually finishes.
  const laterFg = 10 * TERMINAL_FOREGROUND_MS;
  m = reduceFeedEvent(m, { type: 'task.update', task: t('job:x', 'done') });
  assert.equal(m.get('job:x')._fgSeen, undefined, 'newly terminal again — no carried stamp, not yet seen');
  m = markSeen(m, laterFg, true);
  assert.equal(m.get('job:x')._fgSeen, laterFg, 'fresh budget starts at the actual finish time');
  assert.equal(pruneTerminal(m, laterFg + TERMINAL_FOREGROUND_MS - 1).size, 1, 'still within its OWN fresh budget');
  assert.equal(pruneTerminal(m, laterFg + TERMINAL_FOREGROUND_MS + 1).size, 0, 'pruned only once its own budget elapses');
});

// FINAL review, important 3. Pruning kept no tombstone, so with the server's
// RETAIN_TERMINAL_S = 900 and the unconditional resnapshot on
// visibilitychange, every foregrounding within 15 minutes re-added every
// finished row with a fresh 60s budget. Background and return three times and
// the same completed job replays three times.
test('pruneTerminal records a tombstone for each row it drops', () => {
  const tombs = new Set();
  let m = new Map([['job:done', t('job:done', 'done')], ['job:run', t('job:run', 'running')]]);
  m = markSeen(m, 1000, true);
  pruneTerminal(m, 1000 + TERMINAL_FOREGROUND_MS + 1, TERMINAL_FOREGROUND_MS, tombs);
  assert.deepEqual([...tombs], ['job:done']);
});

test('a snapshot never resurrects a tombstoned terminal row', () => {
  const tombs = new Set(['job:done']);
  const m = reduceFeedEvent(new Map(), { type: 'tasks.snapshot', tasks: [t('job:done', 'done'), t('job:live')] }, tombs);
  assert.deepEqual([...m.keys()], ['job:live']);
});

test('three foregroundings replay a finished row zero times, not three', () => {
  const tombs = new Set();
  let m = new Map();
  const snapshot = { type: 'tasks.snapshot', tasks: [t('job:done', 'done')] };
  let fg = 1000;
  let replays = 0;
  for (let i = 0; i < 3; i++) {
    const before = m.size;
    m = reduceFeedEvent(m, snapshot, tombs);
    if (i > 0 && m.size > before) replays++;
    m = markSeen(m, fg, true);
    m = pruneTerminal(m, fg + TERMINAL_FOREGROUND_MS + 1, TERMINAL_FOREGROUND_MS, tombs);
    fg += 2 * TERMINAL_FOREGROUND_MS;
  }
  assert.equal(replays, 0);
  assert.equal(m.size, 0);
});

test('a tombstoned id that genuinely starts running again is admitted and forgets its tombstone', () => {
  const tombs = new Set(['pm-upload-ldwm']);
  const m = reduceFeedEvent(new Map(), { type: 'tasks.snapshot', tasks: [t('pm-upload-ldwm', 'running')] }, tombs);
  assert.equal(m.size, 1);
  assert.equal(tombs.has('pm-upload-ldwm'), false, 'a re-run must be able to finish visibly');
});

test('the tombstone set is bounded so it cannot grow without limit', () => {
  const tombs = new Set();
  for (let i = 0; i < TOMBSTONE_MAX + 50; i++) {
    let m = new Map([[`job:${i}`, { id: `job:${i}`, state: 'done', updated: 1 }]]);
    m = markSeen(m, 1000, true);
    pruneTerminal(m, 1000 + TERMINAL_FOREGROUND_MS + 1, TERMINAL_FOREGROUND_MS, tombs);
  }
  assert.equal(tombs.size, TOMBSTONE_MAX);
  assert.equal(tombs.has('job:0'), false, 'oldest evicted first');
  assert.equal(tombs.has(`job:${TOMBSTONE_MAX + 49}`), true, 'newest retained');
});

test('with no tombstone set passed, pruneTerminal and reduceFeedEvent behave exactly as before', () => {
  let m = new Map([['job:done', t('job:done', 'done')]]);
  m = markSeen(m, 1000, true);
  assert.equal(pruneTerminal(m, 1000 + TERMINAL_FOREGROUND_MS + 1).size, 0);
  const m2 = reduceFeedEvent(new Map(), { type: 'tasks.snapshot', tasks: [t('job:done', 'done')] });
  assert.equal(m2.size, 1);
});

test('a row that goes directly interrupted to done (task_ingest.py:130-142 terminal-file exemption) also earns a fresh budget', () => {
  let m = new Map([['job:y', t('job:y', 'interrupted')]]);
  m = markSeen(m, 1000, true); // stamped while interrupted, at fg=1000
  m = reduceFeedEvent(m, { type: 'task.update', task: t('job:y', 'done') });
  assert.equal(m.get('job:y')._fgSeen, undefined, 'different terminal state — no carry-forward despite both being terminal');
  const laterFg = 500_000;
  m = markSeen(m, laterFg, true);
  assert.equal(pruneTerminal(m, laterFg + TERMINAL_FOREGROUND_MS - 1).size, 1);
  assert.equal(pruneTerminal(m, laterFg + TERMINAL_FOREGROUND_MS + 1).size, 0);
});

test('an unknown typed event leaves the map untouched rather than corrupting it', () => {
  const before = new Map([['a', { id: 'a', state: 'running' }]]);
  const after = reduceFeedEvent(before, { type: 'task.something-new', id: 'a' });
  assert.equal(after.get('a').state, 'running');
  assert.equal(after.size, 1);
});
