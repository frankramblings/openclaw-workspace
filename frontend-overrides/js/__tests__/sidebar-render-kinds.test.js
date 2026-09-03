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
  { id: 'pe1', name: 'Expanded Thread', created: 1, updated: NOW - 6000, opened: null, folder: 'projB' },
];
const projects = [
  { id: 'projA', name: 'Project A' },
  { id: 'projB', name: 'Project B' },
];

function buildState() {
  const groups = buildThreadGroups({
    sessions, projects, running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: null, expanded: new Set(['projB']),
  });
  return { convFilter: '', convSort: 'recent', live: { chat: { cwd: '/x', rowMenuOpen: null, groups } } };
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
