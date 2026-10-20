// Region patching: render() used to rebuild root.innerHTML wholesale, so every
// thread switch re-parsed the whole shell (Chrome trace 2026-10-20: ~83% of
// main-thread time in Parse HTML + set innerHTML). region-patch.js replaces
// only the regions whose HTML changed and reconciles the sidebar rows
// individually. These tests run against a real DOM (jsdom) and assert NODE
// IDENTITY: an untouched row must be the very same node afterwards.
import { test } from 'node:test';
import assert from 'node:assert';
import { reconcileChunks, patchRegions, snapshotAfterFull } from '../redesign/region-patch.js';
import { renderChatListParts } from '../redesign/surfaces.js';
import { buildThreadGroups } from '../redesign/thread-groups.js';

async function loadJsdom() {
  for (const spec of ['jsdom', '/home/frank/code/openclaw/node_modules/jsdom/lib/api.js']) {
    try { return (await import(spec)).JSDOM; } catch (_) { /* try next */ }
  }
  return null;
}
const JSDOM = await loadJsdom();
const t = JSDOM ? test : test.skip;

function mount(html = '') {
  const dom = new JSDOM(`<body><div id="c">${html}</div></body>`);
  return dom.window.document.getElementById('c');
}
const row = (id, extra = '') => `<div class="conv-row${extra}" data-arg="${id}">${id}</div>`;
const ids = (el) => Array.from(el.childNodes).map((n) => n.getAttribute('data-arg'));

t('reconcileChunks keeps identical nodes, builds only the changed one', () => {
  const prev = [row('a'), row('b'), row('c')];
  const c = mount(prev.join(''));
  const [na, nb, nc] = Array.from(c.childNodes);
  const next = [row('a'), row('b', ' active'), row('c')];
  const st = reconcileChunks(c, prev, next);
  assert.deepStrictEqual(ids(c), ['a', 'b', 'c']);
  assert.strictEqual(c.childNodes[0], na);
  assert.notStrictEqual(c.childNodes[1], nb);
  assert.ok(c.childNodes[1].className.includes('active'));
  assert.strictEqual(c.childNodes[2], nc);
  assert.strictEqual(st.created, 1);
});

t('reconcileChunks handles reorder, insert and removal while reusing nodes', () => {
  const prev = [row('a'), row('b'), row('c'), row('d')];
  const c = mount(prev.join(''));
  const byId = Object.fromEntries(Array.from(c.childNodes).map((n) => [n.getAttribute('data-arg'), n]));
  const next = [row('d'), row('x'), row('a'), row('c')];
  const st = reconcileChunks(c, prev, next);
  assert.deepStrictEqual(ids(c), ['d', 'x', 'a', 'c']);
  assert.strictEqual(c.childNodes[0], byId.d);
  assert.strictEqual(c.childNodes[2], byId.a);
  assert.strictEqual(c.childNodes[3], byId.c);
  assert.strictEqual(st.created, 1);
  assert.strictEqual(c.childNodes.length, 4);
});

t('reconcileChunks pairs duplicate chunks one-to-one', () => {
  const prev = [row('a'), row('a')];
  const c = mount(prev.join(''));
  reconcileChunks(c, prev, [row('a'), row('a'), row('a')]);
  assert.deepStrictEqual(ids(c), ['a', 'a', 'a']);
});

t('reconcileChunks refuses a container that has drifted from its snapshot', () => {
  const c = mount(row('a') + row('b'));
  assert.throws(() => reconcileChunks(c, [row('a')], [row('a')]), /out of sync/);
});

t('reconcileChunks refuses a chunk that is not exactly one element', () => {
  const c = mount(row('a'));
  assert.throws(() => reconcileChunks(c, [row('a')], [row('a') + row('b')]), /one element/);
});

function body(regions) {
  const dom = new JSDOM(`<body><div id="b">${regions.map((r) => r.full).join('')}</div></body>`);
  return dom.window.document.getElementById('b');
}
const reg = (key, html, extra = {}) => ({ key, full: html, ...extra });

t('patchRegions replaces only the regions whose html changed', () => {
  const prev = [reg('rail', '<div class="r">r</div>'), reg('center', '<div class="c">one</div>')];
  const b = body(prev);
  const [rail, center] = Array.from(b.children);
  const next = [reg('rail', '<div class="r">r</div>'), reg('center', '<div class="c">two</div>')];
  const res = patchRegions(b, prev, next);
  assert.deepStrictEqual(res.replaced, ['center']);
  assert.strictEqual(b.children[0], rail);
  assert.notStrictEqual(b.children[1], center);
  assert.strictEqual(b.children[1].textContent, 'two');
});

t('patchRegions returns null when the region layout changed (caller rebuilds)', () => {
  const prev = [reg('rail', '<div>r</div>'), reg('center', '<div>c</div>')];
  const b = body(prev);
  assert.strictEqual(patchRegions(b, prev, [reg('rail', '<div>r</div>')]), null);
  assert.strictEqual(patchRegions(b, prev, [reg('rail', '<div>r</div>'), reg('other', '<div>c</div>')]), null);
});

t('patchRegions returns null when the live DOM no longer matches the snapshot', () => {
  const prev = [reg('rail', '<div>r</div>'), reg('center', '<div>c</div>')];
  const b = body(prev);
  b.removeChild(b.lastChild);
  assert.strictEqual(patchRegions(b, prev, prev), null);
});

const listRegion = (rows, shellExtra = '') => {
  const shell = `<div class="list">${shellExtra}<div class="conv-scroll"></div></div>`;
  const full = `<div class="list">${shellExtra}<div class="conv-scroll">${rows.join('')}</div></div>`;
  return { key: 'list', full, shell, chunks: rows, slotSel: '.conv-scroll' };
};

t('patchRegions reconciles sidebar rows in place when only rows changed', () => {
  const prev = [listRegion([row('a'), row('b'), row('c')]), reg('center', '<div>c</div>')];
  const b = body(prev);
  const listEl = b.children[0];
  const slot = listEl.querySelector('.conv-scroll');
  const [na, , nc] = Array.from(slot.childNodes);
  const next = [listRegion([row('a'), row('b', ' active'), row('c')]), reg('center', '<div>c</div>')];
  const res = patchRegions(b, prev, next);
  assert.strictEqual(b.children[0], listEl, 'list shell kept');
  assert.strictEqual(listEl.querySelector('.conv-scroll'), slot, 'scroller kept');
  assert.strictEqual(slot.childNodes[0], na);
  assert.strictEqual(slot.childNodes[2], nc);
  assert.ok(slot.childNodes[1].className.includes('active'));
  assert.deepStrictEqual(res.replaced, ['list:rows']);
});

t('patchRegions keeps the existing rows when only the shell changed (search text, composer)', () => {
  const prev = [listRegion([row('a'), row('b')], '<input value="">')];
  const b = body(prev);
  const listEl = b.children[0];
  const rowNodes = Array.from(listEl.querySelector('.conv-scroll').childNodes);
  const res = patchRegions(b, prev, [listRegion([row('a'), row('b')], '<input value="x">')]);
  assert.notStrictEqual(b.children[0], listEl, 'shell is rebuilt');
  assert.strictEqual(b.children[0].querySelector('input').getAttribute('value'), 'x');
  const after = Array.from(b.children[0].querySelector('.conv-scroll').childNodes);
  assert.deepStrictEqual(after, rowNodes, 'the very same row nodes were carried into the new shell');
  assert.deepStrictEqual(res.replaced, ['list:shell+rows']);
  assert.strictEqual(res.snapshot[0].chunks.length, 2);
});

t('patchRegions rebuilds a region whose rows were not tracked (chunks null before)', () => {
  const prev = [{ ...listRegion([row('a')]), chunks: null }];
  const b = body(prev);
  const listEl = b.children[0];
  const res = patchRegions(b, prev, [listRegion([row('a'), row('b')])]);
  assert.notStrictEqual(b.children[0], listEl);
  assert.deepStrictEqual(res.replaced, ['list']);
  assert.strictEqual(res.snapshot[0].chunks.length, 2, 'rows are patchable again next render');
});

t('patchRegions falls back to a rebuild when something else wrote into the slot', () => {
  const prev = [listRegion([row('a'), row('b')])];
  const b = body(prev);
  b.children[0].querySelector('.conv-scroll').appendChild(b.ownerDocument.createElement('i'));
  const res = patchRegions(b, prev, [listRegion([row('a'), row('c')])]);
  assert.deepStrictEqual(res.replaced, ['list']);
  assert.deepStrictEqual(ids(b.children[0].querySelector('.conv-scroll')), ['a', 'c']);
});

t('snapshotAfterFull drops chunk tracking when the rendered rows are not one element each', () => {
  const regions = [listRegion([row('a'), row('b')])];
  const b = body(regions);
  assert.ok(snapshotAfterFull(b, regions)[0].chunks);
  const bad = [{ ...listRegion([row('a'), row('b')]), chunks: [row('a'), row('b'), row('zzz')] }];
  assert.strictEqual(snapshotAfterFull(b, bad)[0].chunks, null);
  assert.strictEqual(snapshotAfterFull(b, [reg('x', '<div></div>'), reg('y', '<div></div>')]), null, 'region count mismatch');
});

// ---- the real sidebar renderer honours the one-element-per-chunk contract ----
const NOW = Date.now();
const sessions = Array.from({ length: 400 }, (_, i) => ({
  id: `s${i}`, name: `Thread ${i}`, created: 1, updated: NOW - i * 60000 - (i > 40 ? 30 * 86400000 : 0), opened: i < 3 ? NOW : null,
}));
function sState(over = {}) {
  const groups = buildThreadGroups({
    sessions, projects: [], running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: 's0', expanded: new Set(), collapsed: new Set(),
  });
  return { convFilter: '', convSort: 'recent', live: { chat: { groups } }, ...over };
}

t('renderChatListParts: every chunk is exactly one element and full == shell + chunks', () => {
  const parts = renderChatListParts(sState());
  assert.ok(Array.isArray(parts.chunks) && parts.chunks.length > 100);
  const c = mount(parts.chunks.join(''));
  assert.strictEqual(c.childNodes.length, parts.chunks.length);
  assert.ok(Array.from(c.childNodes).every((n) => n.nodeType === 1));
  const joined = parts.shell.replace('<div class="conv-scroll"></div>', `<div class="conv-scroll">${parts.chunks.join('')}</div>`);
  assert.strictEqual(joined, parts.full);
});

t('renderChatListParts: filtering falls back to an opaque list (no chunk tracking)', () => {
  const parts = renderChatListParts(sState({ convFilter: 'thread 1' }));
  assert.strictEqual(parts.chunks, null);
  assert.ok(parts.full.includes('conv-scroll'));
});

t('a thread switch through the real renderer reuses almost every sidebar row', () => {
  const before = renderChatListParts(sState());
  const c = mount(before.chunks.join(''));
  const nodes = Array.from(c.childNodes);
  const groups = buildThreadGroups({
    sessions, projects: [], running: new Set(), notified: new Set(), queued: new Set(),
    now: NOW, activeId: 's2', expanded: new Set(), collapsed: new Set(),
  });
  const after = renderChatListParts({ ...sState(), live: { chat: { groups } } });
  const st = reconcileChunks(c, before.chunks, after.chunks);
  assert.ok(st.created <= 6, `a switch should rebuild a handful of rows, built ${st.created}`);
  const kept = Array.from(c.childNodes).filter((n) => nodes.includes(n)).length;
  assert.ok(kept >= after.chunks.length - 6, `kept ${kept} of ${after.chunks.length}`);
});

// ---- the chat surface honours the same contract ------------------------------
import { renderCenterParts } from '../redesign/surfaces.js';

function chatState(thread, over = {}) {
  return {
    surface: 'chat', draft: '', convFilter: '', branchPrefix: [],
    live: { chat: { thread, activeId: 's0', title: 'T', sessions: [], groups: [] } },
    ...over,
  };
}
const msgs = [
  { id: 'u1', role: 'user', text: 'hello there' },
  { id: 'a1', role: 'assistant', text: 'Hi **Frank**\n\n```js\nconst x = 1;\n```' },
  { id: 'u2', role: 'user', text: 'and a second question' },
  { id: 'a2', role: 'assistant', text: 'second answer' },
];

t('renderCenterParts(chat): one element per message, full == shell + chunks', () => {
  const parts = renderCenterParts(chatState(msgs));
  assert.strictEqual(parts.chunks.length, msgs.length);
  const c = mount(parts.chunks.join(''));
  assert.strictEqual(c.childNodes.length, msgs.length);
  assert.ok(Array.from(c.childNodes).every((n) => n.nodeType === 1));
  assert.ok(parts.shell.includes('<div class="chat-thread"></div>'));
  assert.strictEqual(parts.shell.replace('<div class="chat-thread"></div>', `<div class="chat-thread">${parts.chunks.join('')}</div>`), parts.full);
});

t('renderCenterParts: an empty thread (welcome) and non-chat surfaces stay opaque', () => {
  assert.strictEqual(renderCenterParts(chatState([])).chunks, null);
  assert.strictEqual(renderCenterParts({ ...chatState(msgs), surface: 'settings' }).chunks, null);
});

t('appending one message to a thread rebuilds exactly that message', () => {
  const before = renderCenterParts(chatState(msgs));
  const c = mount(before.chunks.join(''));
  const nodes = Array.from(c.childNodes);
  const after = renderCenterParts(chatState([...msgs, { id: 'u3', role: 'user', text: 'one more' }]));
  const st = reconcileChunks(c, before.chunks, after.chunks);
  assert.strictEqual(st.created, 1);
  nodes.forEach((n, i) => assert.strictEqual(c.childNodes[i], n));
});
