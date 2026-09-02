import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildSwitcherSections, flatRows, clampSel, mruRows, renderSwitcher, RECENT_LIMIT, THREAD_LIMIT,
} from '../redesign/switcher.js';

const S = (id, name, extra = {}) => ({ id, name, created: 1, updated: 1, ...extra });
const sessions = [
  S('a', 'Kamino oMLX', { updated: 5 }),
  S('b', 'Wistia smart crop', { updated: 4 }),
  S('c', 'Plex down', { updated: 3, archived: true }),
  S('d', 'Kamino models', { updated: 2 }),
];

test('empty query shows RECENT from mru, skipping unknown and archived ids', () => {
  const secs = buildSwitcherSections({ query: '', sessions, mru: ['d', 'zzz', 'c', 'a'], activeId: 'a' });
  assert.equal(secs.length, 1);
  assert.equal(secs[0].label, 'RECENT');
  assert.deepEqual(secs[0].rows.map((r) => r.id), ['d', 'a']);
  assert.equal(secs[0].rows[1].active, true);
});

test('empty query with empty mru yields no sections', () => {
  assert.deepEqual(buildSwitcherSections({ query: '', sessions, mru: [] }), []);
});

test('query filters titles case-insensitively, newest first, capped', () => {
  const secs = buildSwitcherSections({ query: 'KAMINO', sessions, mru: [] });
  assert.equal(secs[0].label, 'THREADS');
  assert.deepEqual(secs[0].rows.map((r) => r.id), ['a', 'd']);
  const many = Array.from({ length: THREAD_LIMIT + 3 }, (_, i) => S(`m${i}`, `match ${i}`, { updated: i }));
  assert.equal(buildSwitcherSections({ query: 'match', sessions: many, mru: [] })[0].rows.length, THREAD_LIMIT);
});

test('MESSAGES section dedupes per session and skips title matches', () => {
  const searchResults = [
    { session_id: 'a', session_name: 'Kamino oMLX', content_snippet: 'x' },
    { session_id: 'b', session_name: 'Wistia smart crop', content_snippet: 'face crop' },
    { session_id: 'b', session_name: 'Wistia smart crop', content_snippet: 'again' },
    { session_id: null },
  ];
  const secs = buildSwitcherSections({ query: 'kamino', sessions, mru: [], searchResults });
  assert.deepEqual(secs.map((s) => s.label), ['THREADS', 'MESSAGES']);
  assert.deepEqual(secs[1].rows, [{ id: 'b', title: 'Wistia smart crop', project: '', active: false, snippet: 'face crop' }]);
});

test('project names resolve from folder when projects are given', () => {
  const secs = buildSwitcherSections({
    query: 'plex', sessions: [S('p', 'Plex down', { folder: 'p1' })], mru: [],
    projects: [{ id: 'p1', name: 'Plex' }],
  });
  assert.equal(secs[0].rows[0].project, 'Plex');
});

test('flatRows and clampSel', () => {
  const secs = buildSwitcherSections({ query: 'kamino', sessions, mru: [] });
  assert.deepEqual(flatRows(secs).map((r) => r.id), ['a', 'd']);
  assert.equal(clampSel(2, 2), 0);
  assert.equal(clampSel(-1, 2), 1);
  assert.equal(clampSel(0, 0), 0);
});

test('mruRows produces sidebar-shaped rows', () => {
  const rows = mruRows(['b', 'a', 'c'], sessions, 'a', 5);
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['active', 'endpointId', 'id', 'important', 'model', 'term', 'title'].sort());
  assert.equal(rows[1].active, true);
});

test('renderSwitcher marks the selected row and escapes titles', () => {
  const s = {
    switchQuery: 'kam',
    live: { chat: { sessions: [S('x', '<b>Kamino</b>')], mru: [], switcherResults: null, switcherSel: 0, activeId: null } },
  };
  const html = renderSwitcher(s);
  assert.ok(html.includes('class="oc-switcher"'));
  assert.ok(html.includes('data-focus="switchQuery"'));
  assert.ok(html.includes('&lt;b&gt;Kamino&lt;/b&gt;'));
  assert.ok(!html.includes('<b>Kamino</b>'));
  assert.ok(html.includes('sw-row active'));
  const empty = renderSwitcher({ switchQuery: 'zzz', live: { chat: { sessions, mru: [] } } });
  assert.ok(empty.includes('No matches'));
});
