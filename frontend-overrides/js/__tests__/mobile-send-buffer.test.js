import { test } from 'node:test';
import assert from 'node:assert';
import { commitMobileEditIfPending } from '../redesign/mobile/edit-flow.js';

test('commitMobileEditIfPending clears mobileEditingPending when set', () => {
  const s = { mobileEditingPending: { originalMsgId: 'u1' } };
  commitMobileEditIfPending(s);
  assert.strictEqual(s.mobileEditingPending, null);
});

test('commitMobileEditIfPending is a no-op when not editing', () => {
  const s = { mobileEditingPending: null };
  commitMobileEditIfPending(s);
  assert.strictEqual(s.mobileEditingPending, null);
});
