import { test } from 'node:test';
import assert from 'node:assert';
import { nativeView, anchorMode, tickElapsed } from '../redesign/task-rows.js';

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

test('interrupted state maps to failed with honest error', () => {
  const v = nativeView(reg({ state: 'interrupted', extra: { native: { id: 't1', status: 'running', sessionKey: 'x' } } }));
  assert.equal(v.status, 'failed');
  assert.match(v.error || '', /interrupt/i);
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
