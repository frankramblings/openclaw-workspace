import { test } from 'node:test';
import assert from 'node:assert';
import { buildSuggestContext, activitySummary } from '../redesign/live/suggest-core.js';

test('formats thread as role-labelled lines, most recent last', () => {
  const ctx = buildSuggestContext([
    { role: 'user', text: 'check my cron jobs' },
    { role: 'assistant', text: 'One job is failing.' },
  ]);
  assert.match(ctx, /^User: check my cron jobs\n\nAssistant: One job is failing\.$/);
});

test('skips empty/whitespace messages and non-array threads', () => {
  assert.strictEqual(buildSuggestContext([{ role: 'user', text: '  ' }]), '');
  assert.strictEqual(buildSuggestContext(null), '');
});

test('appends extra activity block after the thread', () => {
  const ctx = buildSuggestContext([{ role: 'user', text: 'hi' }], 'Assistant is still working.');
  assert.match(ctx, /User: hi\n\nAssistant is still working\.$/);
});

test('caps at 4000 chars keeping the tail', () => {
  const long = 'a'.repeat(5000) + 'TAIL';
  const ctx = buildSuggestContext([{ role: 'user', text: long }]);
  assert.strictEqual(ctx.length, 4000);
  assert.ok(ctx.endsWith('TAIL'));
});

test('activitySummary lists recent step labels, empty when no steps', () => {
  assert.strictEqual(activitySummary(null), '');
  assert.strictEqual(activitySummary({ steps: [] }), '');
  const s = activitySummary({ steps: [
    { label: 'Ran command', file: 'backend/cron.py' },
    { label: 'Thinking' },
  ] });
  assert.match(s, /still working/i);
  assert.match(s, /- Ran command backend\/cron\.py/);
  assert.match(s, /- Thinking/);
});
