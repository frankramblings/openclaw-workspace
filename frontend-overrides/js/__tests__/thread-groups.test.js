import { test } from 'node:test';
import assert from 'node:assert';
import { buildThreadGroups, orderWithForks, bucketFor, OPEN_WINDOW_MS, OPEN_CAP } from '../redesign/thread-groups.js';

const NOW = Date.UTC(2026, 8, 1, 15, 0, 0);   // Tue 2026-09-01 15:00 UTC
const H = 3600 * 1000;
const S = (id, o = {}) => ({ id, name: `T ${id}`, created: NOW - 10 * H, updated: NOW - 10 * H, ...o });
const build = (over = {}) => buildThreadGroups({
  sessions: [], projects: [], running: new Set(), notified: new Set(), queued: new Set(),
  now: NOW, activeId: null, expanded: new Set(), ...over,
});
const kinds = (g) => g.map((x) => x.kind);
const ids = (g) => g.rows.map((r) => r.id);

test('OPEN takes threads opened within 48h, running, queued, or active; nothing else', () => {
  const sessions = [
    S('recent', { opened: NOW - 1 * H }),
    S('stale', { opened: NOW - OPEN_WINDOW_MS - 1 }),
    S('run', { opened: null }),
    S('q', { opened: null }),
    S('act', { opened: null }),
    S('plain'),
    S('arch', { opened: NOW, archived: true }),
  ];
  const g = build({ sessions, running: new Set(['run']), queued: new Set(['q']), activeId: 'act' });
  assert.equal(g[0].kind, 'open');
  assert.deepEqual(ids(g[0]).sort(), ['act', 'q', 'recent', 'run']);
  assert.equal(ids(g[0])[0], 'run', 'running threads first');
  const rest = g.slice(1).flatMap((x) => x.rows.map((r) => r.id));
  assert.deepEqual(rest.sort(), ['plain', 'stale'], 'no duplicates across sections, archived hidden');
});

test('OPEN rows are ordered by opened desc and numbered 1..9', () => {
  const sessions = [S('a', { opened: NOW - 3 * H }), S('b', { opened: NOW - 1 * H }), S('c', { opened: NOW - 2 * H })];
  const g = build({ sessions });
  assert.deepEqual(ids(g[0]), ['b', 'c', 'a']);
  assert.deepEqual(g[0].rows.map((r) => r.slot), [1, 2, 3]);
  assert.equal(g[0].meta.count, 3);
});

test('cap evicts the oldest non-running non-active rows; running/active never evicted', () => {
  const sessions = [];
  for (let i = 0; i < OPEN_CAP + 3; i++) sessions.push(S(`s${i}`, { opened: NOW - i * H }));
  sessions.push(S('oldrun', { opened: NOW - 40 * H }));
  const g = build({ sessions, running: new Set(['oldrun']), activeId: `s${OPEN_CAP + 2}` });
  const open = ids(g[0]);
  assert.equal(open.length, OPEN_CAP);
  assert.ok(open.includes('oldrun'));
  assert.ok(open.includes(`s${OPEN_CAP + 2}`), 'active row kept');
  assert.ok(!open.includes(`s${OPEN_CAP + 1}`), 'oldest plain row evicted');
  assert.ok(!open.includes(`s${OPEN_CAP}`), 'second oldest plain row evicted');
});

test('live flags never light on the active row', () => {
  const g = build({ sessions: [S('a', { opened: NOW }), S('b', { opened: NOW })], running: new Set(['a', 'b']), notified: new Set(['b']), queued: new Set(['a', 'b']), activeId: 'a' });
  const a = g[0].rows.find((r) => r.id === 'a'); const b = g[0].rows.find((r) => r.id === 'b');
  assert.equal(a.working, false); assert.equal(b.working, true); assert.equal(b.notify, true);
  assert.equal(a.queued, false, 'active row never shows queued, even when in the queued set');
  assert.equal(b.queued, true);
});

test('RECENT keeps the date buckets and the pinned shelf for unfiled threads', () => {
  const sessions = [S('today', { updated: NOW - 1 * H }), S('yday', { updated: NOW - 26 * H }), S('pin', { updated: NOW - 100 * H, important: true })];
  const g = build({ sessions });
  assert.deepEqual(kinds(g), ['pinned', 'recent', 'recent']);
  assert.deepEqual(ids(g[0]), ['pin']);
  assert.equal(g[1].label, 'TODAY'); assert.equal(g[2].label, 'YESTERDAY');
});

test('bucketFor labels', () => {
  const noon = new Date(2026, 8, 1, 12).getTime();   // local time, Tuesday
  assert.equal(bucketFor(noon - H, noon), 'TODAY');
  assert.equal(bucketFor(noon - 24 * H, noon), 'YESTERDAY');
  assert.equal(bucketFor(noon - 30 * 24 * H, noon), 'AUGUST');
  assert.equal(bucketFor(new Date(2025, 0, 5).getTime(), noon), 'JANUARY 2025');
});

test('projects group filed threads, roll up live state, sort by latest activity, collapse by default', () => {
  const projects = [{ id: 'p1', name: 'Local AI' }, { id: 'p2', name: 'Plex' }, { id: 'p3', name: 'Wedding', archived: true }];
  const sessions = [
    S('l1', { folder: 'p1', updated: NOW - 5 * H }), S('l2', { folder: 'p1', updated: NOW - 6 * H }),
    S('x1', { folder: 'p2', updated: NOW - 2 * H }),
    S('w1', { folder: 'p3', updated: NOW - 1 * H }),
    S('ghost', { folder: 'p-gone' }),
  ];
  // l2 is running, so it now sits on the OPEN shelf; its project's roll-up
  // still counts it, but its rows list drops it.
  const g = build({ sessions, projects, running: new Set(['l2']), notified: new Set(['l1']) });
  assert.deepEqual(kinds(g), ['open', 'project', 'project', 'recent']);
  assert.deepEqual(ids(g[0]), ['l2']);
  assert.equal(g[1].label, 'Plex'); assert.equal(g[2].label, 'Local AI');
  assert.deepEqual(g[2].meta, { id: 'p1', count: 2, working: 1, unseen: 1, collapsed: true, latest: NOW - 5 * H });
  assert.deepEqual(ids(g[2]), ['l1']);
  assert.deepEqual(ids(g[3]), ['ghost'], 'unknown folder id renders as unfiled; archived project threads hidden');
});

test('the project holding the active thread is expanded; expanded set expands others', () => {
  const projects = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
  const sessions = [S('a', { folder: 'p1', opened: null }), S('b', { folder: 'p2' })];
  let g = build({ sessions, projects, activeId: 'a' });
  // active thread is in OPEN, so p1's rows are empty, but the group still
  // reports and is expanded because the roll-up sees the active session.
  assert.deepEqual(kinds(g), ['open', 'project', 'project']);
  const p1 = g.find((x) => x.meta.id === 'p1'); const p2 = g.find((x) => x.meta.id === 'p2');
  assert.equal(p1.meta.collapsed, false); assert.equal(p1.meta.count, 1); assert.equal(p1.rows.length, 0);
  assert.equal(p2.meta.collapsed, true);
  g = build({ sessions, projects, expanded: new Set(['p2']) });
  assert.equal(g.find((x) => x.meta.id === 'p2').meta.collapsed, false);
});

test('forks nest under their parent within a project; pinned float first; cycles do not hang', () => {
  const rows = [
    { id: 'c', parentId: 'p', important: false }, { id: 'p', parentId: null, important: false },
    { id: 'z', parentId: null, important: true }, { id: 'gc', parentId: 'c', important: false },
    { id: 'x', parentId: 'y', important: false }, { id: 'y', parentId: 'x', important: false },
  ];
  const out = orderWithForks(rows);
  assert.deepEqual(out.map((r) => `${r.id}:${r.depth}`), ['z:0', 'p:0', 'c:1', 'gc:2', 'x:0', 'y:0']);
});

test('the same session never appears twice and inputs are not mutated', () => {
  const sessions = [S('a', { opened: NOW, folder: 'p1', important: true })];
  const before = JSON.stringify(sessions);
  const g = build({ sessions, projects: [{ id: 'p1', name: 'P' }] });
  // a is on the OPEN shelf, so its project group is empty but still reports.
  assert.deepEqual(kinds(g), ['open', 'project']);
  assert.equal(g[1].rows.length, 0);
  assert.equal(g[1].meta.count, 1);
  assert.equal(JSON.stringify(sessions), before);
});

test('a running thread filed under an archived project still reaches OPEN', () => {
  const sessions = [S('s1', { folder: 'p1', opened: null })];
  const projects = [{ id: 'p1', name: 'Done', archived: true }];
  const g = build({ sessions, projects, running: new Set(['s1']) });
  assert.deepEqual(kinds(g), ['open']);
  assert.deepEqual(ids(g[0]), ['s1']);
});

test('a project holding the active thread expands and lists its other threads', () => {
  const projects = [{ id: 'p1', name: 'P' }];
  const sessions = [S('a', { folder: 'p1', opened: null }), S('c', { folder: 'p1', updated: NOW - 3 * H })];
  const g = build({ sessions, projects, activeId: 'a' });
  assert.deepEqual(kinds(g), ['open', 'project']);
  assert.equal(g[1].meta.collapsed, false);
  assert.deepEqual(ids(g[1]), ['c']);
  assert.equal(g[1].meta.count, 2);
});

test('project latest and roll-ups include threads on the shelf', () => {
  const projects = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
  const sessions = [
    S('x', { folder: 'p1', opened: NOW, updated: NOW - 1 * H }),
    S('y', { folder: 'p1', updated: NOW - 9 * H }),
    S('z', { folder: 'p2', updated: NOW - 2 * H }),
  ];
  const g = build({ sessions, projects });
  const projGroups = g.filter((x) => x.kind === 'project');
  assert.deepEqual(projGroups.map((x) => x.label), ['A', 'B']);
  assert.equal(projGroups[0].meta.count, 2);
  assert.deepEqual(ids(projGroups[0]), ['y']);
});
