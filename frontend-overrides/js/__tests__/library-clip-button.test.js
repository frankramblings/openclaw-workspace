import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';

test('library surface: Clip URL button renders with the clipUrl action', () => {
  const html = renderCenter({ surface: 'library', live: { library: { items: [] } } });
  assert.match(html, /data-act="clipUrl"/);
  assert.match(html, />Clip URL</);
});

test('library surface: Clip URL button has no em dash in its own copy', () => {
  // Fix round 1 (review): scoped to the button element itself, not the whole
  // library surface -- other copy in this surface (e.g. the cap-notice
  // line about refining to see more) legitimately uses an em
  // dash, and asserting over the whole HTML blob coupled this test to that
  // unrelated copy.
  const html = renderCenter({ surface: 'library', live: { library: { items: [] } } });
  const m = html.match(/<button class="btn" data-act="clipUrl"[^>]*>([^<]*)<\/button>/);
  assert.ok(m, 'Clip URL button not found');
  assert.equal(m[1], 'Clip URL');
  assert.ok(!m[0].includes('—'));
});
