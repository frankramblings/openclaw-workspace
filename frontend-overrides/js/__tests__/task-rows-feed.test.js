import { test } from 'node:test';
import assert from 'node:assert';
import { nativeView, anchorMode, tickElapsed, tickerOwnsElapsed, badgeFor, rowDetail, barFor } from '../redesign/task-rows.js';

const reg = (over = {}) => ({
  id: 'taskfile:t1', kind: 'job', source: 'taskfile', label: 'publish',
  session_key: 'agent:main:web-6b3ccecab880', turn_id: null, state: 'running',
  pct: 40, eta: 90, detail: 'uploading', error: '', created: 1000, updated: 2000,
  extra: { native: { id: 't1', label: 'publish', status: 'running', pct: 40, kind: 'publish', sessionKey: 'agent:main:web-6b3ccecab880' } },
  ...over,
});

test('taskfile record renders its native payload', () => {
  const v = nativeView(reg());
  assert.equal(v.id, 't1');
  assert.equal(v.kind, 'publish');          // native kind drives KIND_COLOR
  assert.equal(v.status, 'running');
});

// FINAL review, critical 1. `interrupted` means "lost track of this, outcome
// unknown" — we never observed an exit status. Before Task 3 it only ever came
// from sweep_boot(), so "✗ failed — interrupted by a backend restart" was at
// least approximately true; the pid-confirmed-death sweeper made it the
// ROUTINE outcome, and both halves of that copy are now false. It gets its own
// status, and the row's wording matches task_push._body's so the banner and
// the row can't contradict each other.
test('interrupted is its own status, never failed', () => {
  const v = nativeView(reg({ state: 'interrupted', extra: { native: { id: 't1', status: 'running', sessionKey: 'x' } } }));
  assert.equal(v.status, 'interrupted');
});

test('interrupted never overwrites the registry error, and never invents a backend restart', () => {
  const v = nativeView(reg({
    state: 'interrupted', error: 'ffmpeg exited 137',
    extra: { native: { id: 't1', status: 'running', sessionKey: 'x' } },
  }));
  assert.equal(v.error, 'ffmpeg exited 137');
  const noErr = nativeView(reg({
    state: 'interrupted', error: '',
    extra: { native: { id: 't1', status: 'running', sessionKey: 'x' } },
  }));
  assert.equal(noErr.error, undefined);
  assert.doesNotMatch(JSON.stringify(noErr), /backend restart/i);
});

test('an interrupted followup row keeps the registry error too', () => {
  const v = nativeView({
    id: 'followup:i1', kind: 'followup', source: 'followup', label: 'x',
    session_key: 'agent:main:web-aaa', turn_id: null, state: 'interrupted',
    pct: null, eta: null, detail: '', error: 'watcher went away', created: 1, updated: 2,
    extra: {},
  });
  assert.equal(v.status, 'interrupted');
  assert.equal(v.error, 'watcher went away');
  assert.doesNotMatch(JSON.stringify(v), /backend restart/i);
});

test('an interrupted row never fills the bar to 100%', () => {
  const det = { mode: 'determinate', pct: 42, showBar: true, showPct: true };
  assert.deepEqual(barFor('done', det), { terminal: true, showBar: true, pct: 100, indeterminate: false });
  assert.deepEqual(barFor('failed', det), { terminal: true, showBar: true, pct: 100, indeterminate: false });
  // Frozen at the last measurement actually taken — never a claimed completion.
  assert.deepEqual(barFor('interrupted', det), { terminal: true, showBar: true, pct: 42, indeterminate: false });
});

test('an interrupted row with no denominator shows an empty track, not a marquee', () => {
  const indet = { mode: 'indeterminate', pct: 0, showBar: false, showPct: false };
  assert.deepEqual(barFor('interrupted', indet),
    { terminal: true, showBar: false, pct: 0, indeterminate: false });
  // A running row with the same leaf still gets the marquee (no over-fix).
  assert.deepEqual(barFor('running', indet),
    { terminal: false, showBar: false, pct: 0, indeterminate: true });
});

test('the interrupted badge is neutral and matches the push copy', () => {
  assert.equal(badgeFor('interrupted'), 'stopped · outcome unknown');
  assert.doesNotMatch(badgeFor('interrupted'), /fail/i);
  assert.equal(badgeFor('done'), '✓ done');
  assert.equal(badgeFor('failed'), '✗ failed');
  assert.equal(badgeFor('running'), 'running');
});

test('followup records synthesize a native view', () => {
  const v = nativeView({
    id: 'followup:ab12', kind: 'followup', source: 'followup', label: 'render 566',
    session_key: 'agent:main:web-6b3ccecab880', turn_id: null, state: 'running',
    pct: null, eta: null, detail: 'waiting for completion ping', error: '',
    created: 0, updated: 0, extra: {},
  });
  assert.equal(v.kind, 'followup');
  assert.equal(v.sessionKey, 'agent:main:web-6b3ccecab880');
});

test('taskfile view backstops sessionKey from the registry record', () => {
  const v = nativeView(reg({
    session_key: 'agent:main:web-6b3ccecab880',
    extra: { native: { id: 't1', label: 'publish', status: 'done' } },  // terminal write dropped sessionKey
  }));
  assert.equal(v.sessionKey, 'agent:main:web-6b3ccecab880');
});

test('job-source records are not chat rows', () => {
  assert.equal(nativeView(reg({ source: 'job', id: 'job:x' })), null);
});

test('anchorMode is turn only on a live turn_id match', () => {
  assert.equal(anchorMode(reg({ turn_id: 7 }), 7), 'turn');
  assert.equal(anchorMode(reg({ turn_id: 7 }), 8), 'pin');
  assert.equal(anchorMode(reg(), 7), 'pin');
});

test('nativeView carries the registry turn_id for anchoring', () => {
  assert.equal(nativeView(reg({ turn_id: 9 }))._recTurnId, 9);
  assert.equal(nativeView(reg())._recTurnId, null);
});

test('auto followups keep their own kind', () => {
  const v = nativeView({
    id: 'followup:a1', kind: 'auto', source: 'followup', label: 'nohup x',
    session_key: 'agent:main:web-6b3ccecab880', turn_id: 9, state: 'running',
    pct: null, eta: null, detail: 'waiting for completion ping', error: '',
    created: 0, updated: 0, extra: {},
  });
  assert.equal(v.kind, 'auto');
  assert.equal(v._recTurnId, 9);
});

test('running followup rows leave elapsed to the ticker', () => {
  const v = nativeView({
    id: 'followup:r1', kind: 'followup', source: 'followup', label: 'x',
    session_key: 'agent:main:web-aaa', turn_id: null, state: 'running',
    pct: null, eta: null, detail: '', error: '', created: 1000, updated: 2000,
    extra: {},
  });
  assert.equal(v.elapsed, null);
});

test('terminal followup rows show server-stamped duration', () => {
  const v = nativeView({
    id: 'followup:d1', kind: 'followup', source: 'followup', label: 'x',
    session_key: 'agent:main:web-aaa', turn_id: null, state: 'done',
    pct: null, eta: null, detail: '', error: '', created: 1000, updated: 91000,
    extra: {},
  });
  assert.equal(v.elapsed, 90);
});

test('tickElapsed derives live seconds for running followup/auto views', () => {
  const v = { kind: 'followup', status: 'running', _createdMs: 100_000 };
  assert.equal(tickElapsed(v, 190_000), 90);
  assert.equal(tickElapsed({ ...v, kind: 'auto' }, 190_000), 90);
});

test('tickElapsed is null for terminal, producer-timed, or unstamped views', () => {
  assert.equal(tickElapsed({ kind: 'followup', status: 'done', _createdMs: 1 }, 2), null);
  assert.equal(tickElapsed({ kind: 'render', status: 'running', _createdMs: 1 }, 2), null);
  assert.equal(tickElapsed({ kind: 'auto', status: 'running', _createdMs: null }, 2), null);
});

test('tickerOwnsElapsed true only for mid-run ticker-owned views', () => {
  const running = { kind: 'auto', status: 'running', _createdMs: 1000, elapsed: null };
  assert.equal(tickerOwnsElapsed(running, 2000), true);
  assert.equal(tickerOwnsElapsed({ ...running, elapsed: 5 }, 2000), false);       // producer/terminal value present
  assert.equal(tickerOwnsElapsed({ ...running, kind: 'render' }, 2000), false);   // producer-timed kind
  assert.equal(tickerOwnsElapsed({ ...running, status: 'done' }, 2000), false);
});

// FINAL review, important 5. The sweeper writes the only honest detail a
// silent/dead producer has ("no update in 4m", "lost track of this process;
// outcome unknown") into rec.detail. Followup rows read it; taskfile rows
// spread extra.native and dropped it entirely — so the whole payoff of the
// `stalled` state was invisible on exactly the podcast/upload pipeline rows
// this project was built for.
test('a stalled taskfile row shows the sweeper detail, not the producer stale text', () => {
  const v = nativeView(reg({
    state: 'stalled', detail: 'no update in 4m',
    extra: { native: { id: 't1', status: 'running', detail: 'frame 300/540' } },
  }));
  assert.equal(v.detail, 'no update in 4m');
  assert.equal(v._sweeperOwned, true);
});

test('an interrupted taskfile row shows the sweeper detail', () => {
  const v = nativeView(reg({
    state: 'interrupted', detail: 'lost track of this process; outcome unknown',
    extra: { native: { id: 't1', status: 'running', detail: 'frame 300/540' } },
  }));
  assert.equal(v.detail, 'lost track of this process; outcome unknown');
});

test('a healthy taskfile row keeps the producer native detail', () => {
  const v = nativeView(reg({
    state: 'running', detail: 'registry echo',
    extra: { native: { id: 't1', status: 'running', detail: 'frame 300/540' } },
  }));
  assert.equal(v.detail, 'frame 300/540');
  assert.equal(v._sweeperOwned, false);
});

test('a sweeper-owned row with no registry detail falls back to the native one', () => {
  const v = nativeView(reg({
    state: 'stalled', detail: '',
    extra: { native: { id: 't1', status: 'running', detail: 'frame 300/540' } },
  }));
  assert.equal(v.detail, 'frame 300/540');
});

test('rowDetail lets the sweeper text beat a stale indeterminate leaf detail', () => {
  const leaf = { mode: 'indeterminate', detail: 'frame 300/540' };
  assert.equal(rowDetail({ detail: 'no update in 4m', _sweeperOwned: true }, leaf, false),
    'no update in 4m');
  // Not sweeper-owned: the producer's live leaf detail still wins, as before.
  assert.equal(rowDetail({ detail: 'registry echo', _sweeperOwned: false }, leaf, false),
    'frame 300/540');
  // Terminal rows always show the row's own detail.
  assert.equal(rowDetail({ detail: 'all done', _sweeperOwned: false }, leaf, true), 'all done');
});
