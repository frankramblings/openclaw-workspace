import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';

const base = {
  surface: 'research', researchQuery: '', researchScope: 'auto', resOpenCtl: null,
  resCfg: { rounds: 'Auto', engine: 'Default', endpoint: 'Claude-Cli', model: 'opus-4' },
  live: { research: { past: [] } },
};

test('running research card shows only live progress, no fabricated steps', () => {
  const html = renderCenter({ ...base, research: 'running', researchProgress: { label: 'Scanning sources…' } });
  assert.match(html, /Scanning sources…/);
  assert.match(html, /data-act="resetResearch"/);
  assert.doesNotMatch(html, /buzzsprout\.com/);
  assert.doesNotMatch(html, /Planned the search/);
  assert.doesNotMatch(html, /12 results/);
});

test('done research card drops the fabricated meta', () => {
  const html = renderCenter({ ...base, research: 'done', live: { research: { past: [], summary: 'All set.', lastRid: 'r1' } } });
  assert.match(html, /Report ready/);
  assert.doesNotMatch(html, /3 rounds · 8 sources/);
});

test('the fake Queue button is gone', () => {
  const html = renderCenter(base);
  assert.doesNotMatch(html, /\+ Queue/);
});

test('Library, Research link is wired', () => {
  const html = renderCenter(base);
  const m = html.match(/<span[^>]*>Library, Research →<\/span>/);
  assert.ok(m, 'link span present');
  assert.match(m[0], /data-act="go"/);
  assert.match(m[0], /data-arg="library"/);
});
