// Desktop sidebar row budget. Frank's list had ~1,700 threads and ~2,350 rows
// after section overlap; every render() re-parsed all of them (18k DOM nodes,
// 3-20s long tasks in a Chrome trace, 2026-10-20). The renderer now draws a
// budget of rows and offers "Show more", mirroring the mobile drawer.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderChatList } from '../redesign/surfaces.js';
import { buildThreadGroups } from '../redesign/thread-groups.js';

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;
const sessions = Array.from({ length: 600 }, (_, i) => ({
  id: `s${i}`, name: `Thread ${i}`, created: 1, updated: NOW - i * 60 * 1000 - (i > 50 ? 40 * DAY : 0), opened: null,
}));

function state(over = {}) {
  const groups = buildThreadGroups({
    sessions, projects: [], running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: 's0', expanded: new Set(), collapsed: new Set(),
  });
  return { convFilter: '', convSort: 'recent', live: { chat: { groups, ...(over.chat || {}) } }, ...over.top };
}

const rowCount = (html) => (html.match(/class="conv-row/g) || []).length;

test('a huge list renders only a budget of rows, not every thread', () => {
  const html = renderChatList(state());
  assert.ok(rowCount(html) <= 130, `expected <=130 rows, got ${rowCount(html)}`);
  assert.ok(rowCount(html) >= 100, 'budget should still fill a screen');
});

test('the active thread always renders', () => {
  assert.ok(renderChatList(state()).includes('data-arg="s0"'));
});

test('a hidden-count "Show more" row appears and names the remainder', () => {
  const html = renderChatList(state());
  assert.ok(html.includes('data-act="showMoreConvs"'));
  assert.match(html, /\d+ hidden/);
});

test('raising chat.convRowLimit renders more rows', () => {
  const more = renderChatList(state({ chat: { convRowLimit: 270 } }));
  assert.ok(rowCount(more) > 250 && rowCount(more) <= 280, `got ${rowCount(more)}`);
});

test('a short list shows everything and no "Show more"', () => {
  const few = sessions.slice(0, 20);
  const groups = buildThreadGroups({
    sessions: few, projects: [], running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: 's0', expanded: new Set(), collapsed: new Set(),
  });
  const html = renderChatList({ convFilter: '', convSort: 'recent', live: { chat: { groups } } });
  assert.ok(!html.includes('showMoreConvs'));
  assert.ok(html.includes('data-arg="s19"'));
});

test('filtering is capped too, so a broad query cannot rebuild 2k rows', () => {
  const html = renderChatList(state({ top: { convFilter: 'thread' } }));
  assert.ok(rowCount(html) <= 130, `got ${rowCount(html)}`);
  assert.ok(html.includes('data-act="showMoreConvs"'));
});
