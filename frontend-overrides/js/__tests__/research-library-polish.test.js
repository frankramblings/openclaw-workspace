// Tasks 5.3 + 5.4 — research & library card polish.
// Research: the composer's Engine/Endpoint/Model pills and the scope chips
// were pure decoration — live/research.js only ever sent {query, max_rounds}
// and backend/research.py's start route reads nothing else from controls that
// existed (MAX_ROUNDS=3 also made the '5' rounds option a lie). The done-card
// "Save to Library" chip navigated without saving anything. Library: raw
// ALLCAPS filenames rendered as-is, and the thumbnail was a flat kind label.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';
import { humanizeTitle, contentSnippet } from '../redesign/live/library-logic.js';

// ---- research surface (task 5.3) --------------------------------------------

const resState = (extra = {}) => ({
  surface: 'research', researchQuery: '', research: 'idle', resOpenCtl: null,
  resCfg: { rounds: 'Auto' }, dismissed: [],
  live: { research: { past: [{ q: 'compare hosts', m: '7:53 · 15 sources', rid: 'r1' }] } },
  ...extra,
});

test('research keeps only the wired Rounds control — no decorative pills, no scope chips', () => {
  const html = renderCenter(resState());
  assert.match(html, /Rounds/);
  assert.doesNotMatch(html, /Engine|Endpoint|opus-4/, 'backend never read these — removed');
  assert.doesNotMatch(html, /scope-chip/, 'scope chips dispatched nothing — removed');
});

test('rounds options stop at the backend MAX_ROUNDS=3 clamp — no fake 5', () => {
  const html = renderCenter(resState({ resOpenCtl: 'rounds' }));
  assert.match(html, /data-act="pickResOpt" data-arg="rounds:3"/);
  assert.doesNotMatch(html, /data-arg="rounds:5"/, 'picking 5 silently sent 3');
});

test('past-run meta is labeled as run duration', () => {
  const html = renderCenter(resState());
  assert.match(html, /class="m" title="run duration · sources fetched">7:53 · 15 sources/);
});

test('done card says In Library (navigation), not Save to Library (no save route exists)', () => {
  const html = renderCenter(resState({ research: 'done' }));
  assert.doesNotMatch(html, /Save to Library/);
  assert.match(html, /In Library →/);
});

// ---- library humanized titles (task 5.4) ------------------------------------

test('humanizeTitle rewrites filename-style ALLCAPS names', () => {
  assert.equal(humanizeTitle('PROPOSAL'), 'Proposal');
  assert.equal(humanizeTitle('MARISSA-BETA-RUNBOOK'), 'Marissa Beta Runbook');
  assert.equal(humanizeTitle('WEEKLY_SYNC_NOTES'), 'Weekly Sync Notes');
});

test('humanizeTitle keeps acronym-ish short tokens and digit tokens intact', () => {
  assert.equal(humanizeTitle('API'), 'API');
  assert.equal(humanizeTitle('API-RUNBOOK'), 'API Runbook');
  assert.equal(humanizeTitle('Q3-REPORT'), 'Q3 Report');
});

test('humanizeTitle keeps dates intact', () => {
  assert.equal(humanizeTitle('MEETING-NOTES-2026-07-01'), 'Meeting Notes 2026-07-01');
});

test('humanizeTitle leaves anything with lowercase alone', () => {
  assert.equal(humanizeTitle('Already Mixed Case'), 'Already Mixed Case');
  assert.equal(humanizeTitle('weekly sync notes'), 'weekly sync notes');
  assert.equal(humanizeTitle('District 9 — discussion guide'), 'District 9 — discussion guide');
});

// ---- library snippet helper + thumbnails (task 5.4) --------------------------

test('contentSnippet strips headings, keeps the first lines, caps the length', () => {
  assert.equal(contentSnippet('# Title\n\nFirst real line.\nSecond line.'),
    'Title\nFirst real line.\nSecond line.');
  assert.equal(contentSnippet(''), '');
  const long = contentSnippet('x'.repeat(500));
  assert.ok(long.length <= 200 && long.endsWith('…'));
});

const libState = (items) => ({
  surface: 'library', libFilter: 'all', libQuery: '', dismissed: [],
  live: { library: { items } },
});

test('library thumb shows content snippet when the API carries one', () => {
  const html = renderCenter(libState([
    { title: 'Doc', kind: 'DOC', kindLabel: 'DOCUMENT', cat: 'doc', when: '2d', snippet: 'First lines of the doc body.' },
  ]));
  assert.match(html, /lib-thumb has-snip/);
  assert.match(html, /First lines of the doc body\./);
});

test('library thumb without a snippet gets a kind icon above the label, not flat text', () => {
  const html = renderCenter(libState([
    { title: 'Doc', kind: 'DOC', kindLabel: 'DOCUMENT', cat: 'doc', when: '2d' },
  ]));
  assert.doesNotMatch(html, /has-snip/);
  assert.match(html, /class="lib-thumb"[^>]*>\s*<span class="k-ico"[^>]*><svg/,
    'kind-colored icon renders in the thumb');
  assert.match(html, /DOCUMENT/);
});
