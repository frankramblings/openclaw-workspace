// Every .oc-search-style input (sidebar conversation filter, ⌘K switcher,
// mobile conversation drawer, mobile email search, desktop email/library/
// notes filters) carries a clear "×" button after the input. CSS shows it
// only while the input has text (:has(input:not(:placeholder-shown))), so
// the markup is unconditional; the pure clear logic lives in search-clear.js
// and app.js's clearField action is a thin wrapper around it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { searchClearBtn, clearSearchField } from '../redesign/search-clear.js';
import { renderChatList } from '../redesign/surfaces.js';
import { renderSwitcher } from '../redesign/switcher.js';
import { renderConvDrawer } from '../redesign/mobile/mobile-sheets.js';
import { buildThreadGroups } from '../redesign/thread-groups.js';

const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// ---- searchClearBtn markup -------------------------------------------------

test('searchClearBtn renders a real button wired to clearField for its field', () => {
  const html = searchClearBtn('convFilter');
  assert.match(html, /<button[^>]*type="button"/);
  assert.match(html, /class="oc-search-clear"/);
  assert.match(html, /data-act="clearField"/);
  assert.match(html, /data-arg="convFilter"/);
  // No data-focus on the button: app.js's switcher keydown handler matches
  // e.target's data-focus, so a keyboard user pressing Enter on a × carrying
  // data-focus="switchQuery" would open the highlighted thread instead of
  // clearing. clearField refocuses the input explicitly after render.
  assert.ok(!html.includes('data-focus='));
  assert.match(html, /aria-label="Clear search"/);
  assert.match(html, /<svg/);
});

test('searchClearBtn escapes the field name it interpolates', () => {
  const html = searchClearBtn('a"b');
  assert.ok(!html.includes('data-arg="a"b"'));
  assert.ok(html.includes('a&quot;b'));
});

// ---- clearSearchField (pure) -----------------------------------------------

test('clearSearchField blanks the field and resets the paired semantic search', () => {
  const calls = [];
  const actions = { convSearch: (q) => calls.push(['convSearch', q]), switcherQuery: (q) => calls.push(['switcherQuery', q]) };
  const state = { convFilter: 'kamino', switchQuery: 'kam', libQuery: 'x' };

  assert.strictEqual(clearSearchField(state, 'convFilter', actions), true);
  assert.strictEqual(state.convFilter, '');
  assert.deepStrictEqual(calls, [['convSearch', '']]);

  assert.strictEqual(clearSearchField(state, 'switchQuery', actions), true);
  assert.strictEqual(state.switchQuery, '');
  assert.deepStrictEqual(calls[1], ['switcherQuery', '']);

  // Plain filters have no paired action: just blank them.
  assert.strictEqual(clearSearchField(state, 'libQuery', actions), true);
  assert.strictEqual(state.libQuery, '');
  assert.strictEqual(calls.length, 2);
});

test('clearSearchField ignores unknown/empty fields and tolerates missing actions', () => {
  const state = { convFilter: 'keep', draft: 'not a search box' };
  assert.strictEqual(clearSearchField(state, '', {}), false);
  assert.strictEqual(clearSearchField(state, null, {}), false);
  assert.strictEqual(clearSearchField(state, 'draft', {}), false);
  assert.strictEqual(state.draft, 'not a search box');
  assert.strictEqual(state.convFilter, 'keep');
  // live/chat.js may not have merged its actions yet (dynamic import).
  assert.strictEqual(clearSearchField(state, 'convFilter', {}), true);
  assert.strictEqual(state.convFilter, '');
  assert.strictEqual(clearSearchField(state, 'convFilter', undefined), true);
});

// ---- render sites ------------------------------------------------------------

const NOW = Date.now();
const sessions = [
  { id: 'o1', name: 'Open One', created: 1, updated: NOW - 1000, opened: NOW - 1000 },
  { id: 'o2', name: 'Open Two', created: 1, updated: NOW - 2000, opened: NOW - 2000 },
];
function groups() {
  return buildThreadGroups({
    sessions, projects: [], running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: null, expanded: new Set(),
  });
}

test('desktop sidebar filter renders the × after its input, inside the same .oc-search', () => {
  const html = renderChatList({
    convFilter: 'open', convSort: 'recent',
    live: { projects: [], chat: { cwd: '/x', rowMenuOpen: null, projMenuOpen: null, groups: groups(), sessions, mru: [] } },
  });
  const box = html.indexOf('class="oc-search"');
  const input = html.indexOf('data-model="convFilter"');
  const btn = html.indexOf('data-act="clearField" data-arg="convFilter"');
  const end = html.indexOf('</div>', box);
  assert.ok(box >= 0 && input > box && btn > input && btn < end, 'button follows the input within the search box');
});

test('⌘K switcher renders the × for switchQuery', () => {
  const html = renderSwitcher({
    switchQuery: 'kam',
    live: { chat: { sessions, mru: [], switcherResults: null, switcherSel: 0, activeId: null } },
  });
  assert.ok(html.includes('data-act="clearField" data-arg="switchQuery"'));
});

test('mobile conversation drawer renders the × for convFilter', () => {
  const html = renderConvDrawer({
    mDrawerOpen: true, mDrawerSide: 'left', convFilter: 'open',
    live: { chat: { groups: groups(), mru: [], sessions, activeId: null } },
  });
  assert.ok(html.includes('data-act="clearField" data-arg="convFilter"'));
});

test('every search box calls searchClearBtn for its own model field (source guard)', () => {
  const files = {
    '../redesign/surfaces.js': ['convFilter', 'emailQuery', 'libQuery', 'notesFilter'],
    '../redesign/switcher.js': ['switchQuery'],
    '../redesign/mobile/mobile-sheets.js': ['convFilter'],
    '../redesign/mobile/mobile-surfaces.js': ['emailQuery'],
  };
  for (const [rel, fields] of Object.entries(files)) {
    const text = src(rel);
    for (const f of fields) {
      assert.ok(text.includes(`searchClearBtn('${f}')`), `${rel} clears ${f}`);
    }
  }
});

test('app.js exposes a clearField action that delegates to clearSearchField', () => {
  const app = src('../redesign/app.js');
  assert.match(app, /clearField:\s*\(field\)\s*=>/);
  assert.ok(app.includes('clearSearchField(state, field, actions)'));
  // Focus goes back to the (rebuilt) input after the click's render.
  assert.ok(app.includes('[data-model="${field}"]'), 'refocuses the cleared input');
});

test('CSS reveals the × only while the input has text', () => {
  const css = src('../../redesign.css');
  assert.ok(css.includes('.oc-search-clear{display:none'), 'hidden by default');
  assert.ok(css.includes('.oc-search:has(input:not(:placeholder-shown)) .oc-search-clear'), 'desktop reveal rule');
  const m = src('../redesign/mobile/mobile.css');
  assert.ok(m.includes('.m-search:has(input:not(:placeholder-shown)) .oc-search-clear'), 'mobile email reveal rule');
  assert.ok(m.includes('.m-drawer-search:has(input:not(:placeholder-shown)) .oc-search-clear'), 'mobile drawer reveal rule');
});
