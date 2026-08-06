import { test } from 'node:test';
import assert from 'node:assert';
import { chevPatchPlan } from '../redesign/chat-activity.js';

test('no previous rotation recorded -> no patch (first render, nothing to animate from)', () => {
  assert.equal(chevPatchPlan(undefined, 'rotate(90deg)'), null);
});

test('previous equals next -> no patch (nothing changed, avoid a pointless reflow)', () => {
  assert.equal(chevPatchPlan('rotate(0deg)', 'rotate(0deg)'), null);
});

test('previous differs from next -> patch plan carries both values in order', () => {
  assert.deepEqual(chevPatchPlan('rotate(0deg)', 'rotate(90deg)'), { from: 'rotate(0deg)', to: 'rotate(90deg)' });
});
