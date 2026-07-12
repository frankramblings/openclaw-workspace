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

// ---------------------------------------------------------------------------
// Task 2.3: an SSE 'error' event must never render as "Report ready" with an
// empty summary and dead buttons — it renders an honest error card with a
// Retry that re-runs the same query (startResearch reads state.researchQuery,
// which is left untouched on error).
// ---------------------------------------------------------------------------
test('errored research shows a failure card with the real message, never "Report ready"', () => {
  const html = renderCenter({
    ...base, research: 'error', researchError: 'The research run failed.',
    live: { research: { past: [] } },
  });
  assert.match(html, /Research failed/);
  assert.match(html, /The research run failed\./);
  assert.match(html, /data-act="startResearch"/);
  assert.doesNotMatch(html, /Report ready/);
});

test('errored research card offers Dismiss (resetResearch) back to idle', () => {
  const html = renderCenter({ ...base, research: 'error', researchError: 'boom' });
  assert.match(html, /data-act="resetResearch"/);
});

test('running, done, and error states are mutually exclusive in the markup', () => {
  const html = renderCenter({ ...base, research: 'error', researchError: 'boom', researchProgress: { label: 'should not show' } });
  assert.doesNotMatch(html, /should not show/);
  assert.doesNotMatch(html, /Report ready/);
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
