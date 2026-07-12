import { test } from 'node:test';
import assert from 'node:assert';
import { suggestGhost } from '../redesign/suggest-ghost.js';

const SUG = { text: 'While you wait, fix the cron job', mode: 'midturn' };

test('renders nothing without a suggestion or with a non-empty draft', () => {
  assert.strictEqual(suggestGhost(null, ''), '');
  assert.strictEqual(suggestGhost({ text: '' }, ''), '');
  assert.strictEqual(suggestGhost(SUG, 'already typing'), '');
});

test('desktop: ghost span with tab hint, no tap action', () => {
  const html = suggestGhost(SUG, '');
  assert.match(html, /class="ghost-suggest"/);
  assert.match(html, /While you wait, fix the cron job/);
  assert.match(html, /tabhint/);
  assert.doesNotMatch(html, /data-act/);
});

test('mobile: tappable ghost, no tab hint', () => {
  const html = suggestGhost(SUG, '', { mobile: true });
  assert.match(html, /ghost-suggest m-ghost/);
  assert.match(html, /data-act="acceptSuggest"/);
  assert.doesNotMatch(html, /tabhint/);
});

test('escapes suggestion text', () => {
  const html = suggestGhost({ text: '<img onerror=x>' }, '');
  assert.doesNotMatch(html, /<img/);
});
