// PINNED / OPEN / date-bucket headers collapse on click (toggleSection) and a
// filter force-opens them so a match is never hidden.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderChatList } from '../redesign/surfaces.js';
import { buildThreadGroups, sectionKey, isSectionCollapsed } from '../redesign/thread-groups.js';

const NOW = Date.now();
const sessions = [
  { id: 'o1', name: 'Open One', created: 1, updated: NOW - 1000, opened: NOW - 1000 },
  { id: 'p1', name: 'Pinned One', created: 1, updated: NOW - 2000, opened: null, important: true },
  { id: 'r1', name: 'Plain One', created: 1, updated: NOW - 3000, opened: null },
];

function state(collapsedSections, convFilter = '') {
  const groups = buildThreadGroups({
    sessions, projects: [], running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: null,
  });
  return { convFilter, convSort: 'recent', live: { projects: [], chat: { cwd: '/x', groups, collapsedSections } } };
}

test('sectionKey covers pinned, open and recent buckets only', () => {
  assert.equal(sectionKey({ kind: 'pinned' }), 'pinned');
  assert.equal(sectionKey({ kind: 'open' }), 'open');
  assert.equal(sectionKey({ kind: 'recent', label: 'Today' }), 'recent:Today');
  assert.equal(sectionKey({ kind: 'project', label: 'x' }), null);
});

test('with nothing collapsed every section header is expandable and every row renders', () => {
  const html = renderChatList(state(new Set()));
  for (const key of ['pinned', 'open']) assert.ok(html.includes(`data-act="toggleSection" data-arg="${key}"`), key);
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(!html.includes('aria-expanded="false"'));
  assert.ok(html.includes('Pinned One') && html.includes('Open One') && html.includes('Plain One'));
});

test('a collapsed section hides its rows but keeps its header and count', () => {
  const html = renderChatList(state(new Set(['pinned', 'open'])));
  assert.ok(html.includes('data-arg="pinned"') && html.includes('data-arg="open"'));
  assert.ok(html.includes('collapsible collapsed'));
  assert.ok(html.includes('aria-expanded="false"'));
  // Pinned One and Open One also sit in the date bucket, which stays open.
  const pinnedHdr = html.indexOf('data-arg="pinned"');
  const openHdr = html.indexOf('data-arg="open"');
  assert.ok(!html.slice(pinnedHdr, openHdr).includes('conv-row'), 'no rows between PINNED and OPEN headers');
});

test('filtering force-opens collapsed sections', () => {
  const html = renderChatList(state(new Set(['pinned', 'open']), 'pinned one'));
  assert.ok(html.includes('Pinned One'));
  assert.ok(!html.includes('aria-expanded="false"'));
});

test('isSectionCollapsed leaves projects on their own meta.collapsed', () => {
  assert.equal(isSectionCollapsed({ kind: 'project', meta: { collapsed: true } }, new Set(), false), true);
  assert.equal(isSectionCollapsed({ kind: 'project', meta: { collapsed: true } }, new Set(), true), false);
  assert.equal(isSectionCollapsed({ kind: 'open' }, new Set(['open']), false), true);
});
