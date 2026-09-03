// F2: the mobile drawer's OPEN/project renderer branches (mobile-sheets.js
// convListHtml, via renderConvDrawer) had no automated coverage. Fixtures
// use the real buildThreadGroups (thread-groups.js), same approach as
// sidebar-render-kinds.test.js's desktop counterpart; renderConvDrawer is
// invoked the same way as mobile-rider-b.test.js does.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderConvDrawer } from '../redesign/mobile/mobile-sheets.js';
import { buildThreadGroups } from '../redesign/thread-groups.js';

const NOW = Date.now();
const sessions = [
  { id: 'o1', name: 'Open One', created: 1, updated: NOW - 1000, opened: NOW - 1000 },
  { id: 'o2', name: 'Open Two (queued)', created: 1, updated: NOW - 2000, opened: NOW - 2000 },
  { id: 'pc1', name: 'Collapsed Thread', created: 1, updated: NOW - 5000, opened: null, folder: 'projA' },
  { id: 'pe1', name: 'Expanded Parent', created: 1, updated: NOW - 6000, opened: null, folder: 'projB' },
  { id: 'pe2', name: 'Expanded Child', created: 1, updated: NOW - 6500, opened: null, folder: 'projB', parent_id: 'pe1' },
];
const projects = [
  { id: 'projA', name: 'Project A' },
  { id: 'projB', name: 'Project B' },
];

function buildState() {
  const groups = buildThreadGroups({
    sessions, projects, running: new Set(), notified: new Set(), queued: new Set(['o2']),
    now: NOW, activeId: null, expanded: new Set(['projB']),
  });
  return {
    mDrawerOpen: true, mDrawerSide: 'left', convFilter: '',
    live: { chat: { groups, mru: [], sessions, activeId: null } },
  };
}

test('the OPEN header comes first, with m-conv-cnt, and its rows follow', () => {
  const html = renderConvDrawer(buildState());
  assert.ok(html.includes('<div class="m-conv-grp open">OPEN <span class="m-conv-cnt">2</span></div>'));
  const openIdx = html.indexOf('m-conv-grp open');
  const rowIdx = html.indexOf('data-arg="o1"');
  assert.ok(openIdx >= 0 && rowIdx > openIdx);
});

test('a collapsed project renders header only, no rows', () => {
  const html = renderConvDrawer(buildState());
  assert.ok(html.includes('data-act="toggleProject" data-arg="projA"'));
  assert.ok(!html.includes('data-arg="pc1"'));
});

test('a depth1 row (forked under its parent) carries the depth1 class', () => {
  const html = renderConvDrawer(buildState());
  assert.ok(html.includes('class="m-conv-row ocrow depth1"'));
});

test('a queued row renders m-conv-dot queued', () => {
  const html = renderConvDrawer(buildState());
  const rowO2 = html.slice(html.indexOf('data-arg="o2"'));
  assert.ok(rowO2.includes('m-conv-dot queued'));
});
