import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';

test('library surface: Clip URL button renders with the clipUrl action', () => {
  const html = renderCenter({ surface: 'library', live: { library: { items: [] } } });
  assert.match(html, /data-act="clipUrl"/);
  assert.match(html, />Clip URL</);
});

test('library surface: Clip URL button has no em dash in its copy', () => {
  const html = renderCenter({ surface: 'library', live: { library: { items: [] } } });
  assert.ok(!html.includes('—'));
});
