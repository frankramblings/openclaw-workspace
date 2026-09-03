// F2: the desktop sidebar's OPEN and project renderer branches (surfaces.js
// convListBody) had no automated coverage. Fixtures are built with the real
// buildThreadGroups (thread-groups.js) instead of hand-rolled group shapes,
// same pattern as redesign-queued-dot.test.js, so this exercises the actual
// model -> renderer contract end to end.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderChatList } from '../redesign/surfaces.js';
import { buildThreadGroups } from '../redesign/thread-groups.js';

const NOW = Date.now();
const sessions = [
  { id: 'o1', name: 'Open One', created: 1, updated: NOW - 1000, opened: NOW - 1000 },
  { id: 'o2', name: 'Open Two', created: 1, updated: NOW - 2000, opened: NOW - 2000 },
  { id: 'pc1', name: 'Collapsed Thread', created: 1, updated: NOW - 5000, opened: null, folder: 'projA' },
  { id: 'pc0', name: 'Something Else', created: 1, updated: NOW - 5500, opened: null, folder: 'projA' },
  { id: 'pe1', name: 'Expanded Thread', created: 1, updated: NOW - 6000, opened: null, folder: 'projB' },
];
const projects = [
  { id: 'projA', name: 'Project A' },
  { id: 'projB', name: 'Project B' },
];

function buildState(opts = {}) {
  const groups = buildThreadGroups({
    sessions, projects, running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: null, expanded: new Set(['projB']),
  });
  return {
    convFilter: opts.convFilter || '',
    convSort: 'recent',
    live: {
      projects: opts.liveProjects || projects,
      chat: {
        cwd: '/x',
        rowMenuOpen: opts.rowMenuOpen != null ? opts.rowMenuOpen : null,
        projMenuOpen: opts.projMenuOpen != null ? opts.projMenuOpen : null,
        groups,
      },
    },
  };
}

test('the OPEN group renders its header with the count, and the first row carries the slot hint + close button', () => {
  const html = renderChatList(buildState());
  assert.ok(html.includes('<div class="conv-group open top"><span class="sect-label">OPEN</span><span class="sect-count">2</span></div>'));
  const rowO1 = html.slice(html.indexOf('data-arg="o1"'), html.indexOf('data-arg="o2"'));
  assert.ok(rowO1.includes('<span class="conv-slot" title="Option+1">⌥1</span>'));
  assert.ok(rowO1.includes('data-act="closeOpen" data-arg="o1"'));
});

test('a collapsed project group renders its header but none of its rows', () => {
  const html = renderChatList(buildState());
  assert.ok(html.includes('data-act="toggleProject" data-arg="projA"'));
  assert.ok(!html.includes('data-arg="pc1"'));
});

test('an expanded project group renders its rows', () => {
  const html = renderChatList(buildState());
  assert.ok(html.includes('data-act="toggleProject" data-arg="projB"'));
  assert.ok(html.includes('data-arg="pe1"'));
});

test('an open row menu carries the Move to submenu with the current project marked', () => {
  const html = renderChatList(buildState({ rowMenuOpen: 'pe1' }));
  const menu = html.slice(html.indexOf('data-arg="pe1"'));
  assert.ok(menu.includes('data-act="moveToProject"'));
  // pe1 is filed under projB: that entry is marked on, the others are not.
  const onMatch = menu.match(/<button class="([^"]*)" data-act="moveToProject" data-arg="pe1\|projB"/);
  assert.ok(onMatch, 'expected a moveToProject item for pe1|projB');
  assert.ok(onMatch[1].split(' ').includes('on'));
  const offMatch = menu.match(/<button class="([^"]*)" data-act="moveToProject" data-arg="pe1\|projA"/);
  assert.ok(offMatch, 'expected a moveToProject item for pe1|projA');
  assert.ok(!offMatch[1].split(' ').includes('on'));
});

test('a project header renders the toggleProjMenu kebab and, when open, the rename/archive menu', () => {
  const closedHtml = renderChatList(buildState());
  const closedHeader = closedHtml.slice(closedHtml.indexOf('data-arg="projB"'), closedHtml.indexOf('data-arg="projB"') + 400);
  assert.ok(closedHeader.includes('data-act="toggleProjMenu" data-arg="projB"'));
  assert.ok(!closedHeader.includes('data-act="renameProject"'));
  assert.ok(!closedHtml.includes('menu-open'));

  const openHtml = renderChatList(buildState({ projMenuOpen: 'projB' }));
  assert.ok(/conv-group project[^"]*menu-open/.test(openHtml));
  const openHeader = openHtml.slice(openHtml.indexOf('data-arg="projB"'), openHtml.indexOf('data-arg="projB"') + 1200);
  assert.ok(openHeader.includes('data-act="renameProject" data-arg="projB"'));
  assert.ok(openHeader.includes('data-act="archiveProject" data-arg="projB"'));
});

test('amendment D: filtering expands a collapsed project and shows the filtered count', () => {
  // With no filter, projA is collapsed and its rows (including pc1, the only
  // match below) are hidden; its meta.count (2) covers pc0 + pc1.
  const collapsedHtml = renderChatList(buildState());
  assert.ok(!collapsedHtml.includes('data-arg="pc1"'));

  const filteredHtml = renderChatList(buildState({ convFilter: 'Collapsed' }));
  const headerIdx = filteredHtml.indexOf('data-arg="projA"');
  assert.ok(headerIdx >= 0, 'projA header must still render when it has a match');
  const header = filteredHtml.slice(filteredHtml.lastIndexOf('<div class="conv-group', headerIdx), headerIdx + 300);
  assert.ok(!/\bcollapsed\b/.test(header.split('"')[1] || header), 'header must not carry the collapsed class while filtering');
  assert.ok(header.includes('aria-expanded="true"'));
  // Only pc1 matches "Collapsed"; pc0 ("Something Else") does not, so the
  // rendered count must be 1 (g.rows.length), not meta.count (2).
  assert.ok(header.includes('<span class="sect-count">1</span>'));
  assert.ok(filteredHtml.includes('data-arg="pc1"'));
  assert.ok(!filteredHtml.includes('data-arg="pc0"'));
});
