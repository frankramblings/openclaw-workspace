import { test } from 'node:test';
import assert from 'node:assert';
import { promiseWarningText } from '../redesign/live/promise-warning.js';

test('warning copy quotes the phrase and states the consequence', () => {
  const t = promiseWarningText("I'll let you know");
  assert.match(t, /I'll let you know/);
  assert.match(t, /no tracked task/i);
  assert.match(t, /will not be pinged/i);
});

test('missing phrase still produces honest copy', () => {
  const t = promiseWarningText('');
  assert.match(t, /follow-up was promised/i);
  assert.match(t, /will not be pinged/i);
});
