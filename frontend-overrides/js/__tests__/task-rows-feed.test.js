import { test } from 'node:test';
import assert from 'node:assert';
import { nativeView, anchorMode } from '../redesign/task-rows.js';

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

test('job-source records are not chat rows', () => {
  assert.equal(nativeView(reg({ source: 'job', id: 'job:x' })), null);
});

test('anchorMode is turn only on a live turn_id match', () => {
  assert.equal(anchorMode(reg({ turn_id: 7 }), 7), 'turn');
  assert.equal(anchorMode(reg({ turn_id: 7 }), 8), 'pin');
  assert.equal(anchorMode(reg(), 7), 'pin');
});
