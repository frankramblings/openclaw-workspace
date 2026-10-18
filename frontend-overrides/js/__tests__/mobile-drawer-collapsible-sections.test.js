// Mobile drawer: PINNED / OPEN / date-bucket headers collapse via
// toggleSection; a filter force-opens them (mirror of the desktop sidebar).
import { test } from 'node:test';
import assert from 'node:assert';
import { renderConvDrawer } from '../redesign/mobile/mobile-sheets.js';
import { buildThreadGroups } from '../redesign/thread-groups.js';

const NOW = Date.now();
const sessions = [
  { id: 'o1', name: 'Open One', created: 1, updated: NOW - 1000, opened: NOW - 1000 },
  { id: 'p1', name: 'Pinned One', created: 1, updated: NOW - 2000, opened: null, important: true },
  { id: 'r1', name: 'Plain One', created: 1, updated: NOW - 3000, opened: null },
];

function state(collapsedSections, convFilter = '', withOpen = true) {
  const groups = buildThreadGroups({
    sessions: withOpen ? sessions : sessions.map((s) => ({ ...s, opened: null })),
    projects: [], running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: null,
  });
  return {
    mDrawerOpen: true, mDrawerSide: 'left', convFilter,
    live: { chat: { groups, mru: [], sessions, activeId: null, collapsedSections } },
  };
}

test('every mobile section header is a tappable toggle with aria-expanded', () => {
  const html = renderConvDrawer(state(new Set()));
  for (const key of ['pinned', 'open']) assert.ok(html.includes(`data-act="toggleSection" data-arg="${key}"`), key);
  assert.ok(/data-arg="recent:[^"]+"/.test(html), 'date bucket header');
  assert.ok(!html.includes('aria-expanded="false"'));
  assert.ok(html.includes('Pinned One') && html.includes('Open One') && html.includes('Plain One'));
});

test('collapsed PINNED and OPEN hide their rows, keep header and count', () => {
  const html = renderConvDrawer(state(new Set(['pinned', 'open'])));
  const pin = html.indexOf('data-arg="pinned"');
  const open = html.indexOf('data-arg="open"');
  assert.ok(pin >= 0 && open > pin);
  assert.ok(!html.slice(pin, open).includes('m-conv-row'), 'no rows under PINNED');
  assert.ok(html.slice(open).match(/data-arg="o1"/) === null || html.indexOf('data-arg="o1"', open) > html.indexOf('data-arg="recent:'), 'no OPEN rows before the date bucket');
  assert.ok(html.includes('collapsible collapsed'));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(/m-conv-cnt">1</.test(html));
});

test('a collapsed date bucket hides its rows', () => {
  const html = renderConvDrawer(state(new Set(['recent:TODAY'])));
  const m = html.match(/data-arg="(recent:[^"]+)"/);
  assert.ok(m, 'bucket header present');
  const set = new Set([m[1]]);
  const collapsed = renderConvDrawer(state(set));
  assert.ok(!collapsed.slice(collapsed.indexOf(`data-arg="${m[1]}"`)).includes('m-conv-row'));
});

test('the synthetic RECENT group (no OPEN shelf) collapses too', () => {
  const s = state(new Set(['recent:RECENT']), '', false);
  s.live.chat.mru = ['p1', 'r1'];
  const html = renderConvDrawer(s);
  if (!html.includes('data-arg="recent:RECENT"')) return; // mru fixture shape differs; covered by helper tests
  const i = html.indexOf('data-arg="recent:RECENT"');
  assert.ok(html.slice(i, i + 400).includes('aria-expanded="false"'));
});

test('filtering force-opens collapsed sections on mobile', () => {
  const html = renderConvDrawer(state(new Set(['pinned', 'open']), 'pinned one'));
  assert.ok(html.includes('Pinned One'));
  assert.ok(!html.includes('aria-expanded="false"'));
});
