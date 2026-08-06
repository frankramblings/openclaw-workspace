import { test } from 'node:test';
import assert from 'node:assert';
import { diffJobIds } from '../redesign/live/jobs.js';

// diffJobIds is the pure id-set diff render() uses to patch existing DOM
// nodes in place instead of replacing the whole job list on every SSE tick
// (see docs/superpowers/specs/2026-06-30-workspace-live-jobs-design.md and
// task 7 of the motion-interaction-fix campaign). DOM-free so it's
// unit-testable without a document.

test('all-new list: everything is an add, nothing to keep or remove', () => {
  const d = diffJobIds([], [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(d, { toAdd: ['a', 'b'], toRemove: [], toKeep: [] });
});

test('unchanged ids across a tick: nothing added or removed, all kept', () => {
  const d = diffJobIds(['a', 'b'], [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(d, { toAdd: [], toRemove: [], toKeep: ['a', 'b'] });
});

test('a finished job drops out, a new one starts: one remove, one add, one keep', () => {
  const d = diffJobIds(['a', 'b'], [{ id: 'a' }, { id: 'c' }]);
  assert.deepEqual(d, { toAdd: ['c'], toRemove: ['b'], toKeep: ['a'] });
});

test('empty next list: everything is a remove', () => {
  const d = diffJobIds(['a', 'b'], []);
  assert.deepEqual(d, { toAdd: [], toRemove: ['a', 'b'], toKeep: [] });
});
