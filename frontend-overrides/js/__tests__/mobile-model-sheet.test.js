// Mobile model sheet: PINNED group + pin buttons (parallel to the desktop
// popover tests in redesign-model-picker.test.js). Browser shims per
// model-sheet-retry.test.js.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { renderModelSheet } = await import('../redesign/mobile/mobile-sheets.js');

const groups = [
  { ep: 'Claude CLI', endpointId: 'claude-cli', hasTag: false, tag: '', models: [
    { id: 'claude-cli·claude-opus-4-8', mid: 'claude-opus-4-8', name: 'Claude Opus 4.8', endpointId: 'claude-cli', ep: 'Claude CLI' },
    { id: 'claude-cli·claude-sonnet-4-6', mid: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', endpointId: 'claude-cli', ep: 'Claude CLI' },
  ] },
  { ep: 'Perplexity', endpointId: 'perplexity-web', hasTag: true, tag: 'chat only', models: [
    { id: 'perplexity-web·claude-sonnet-4-6', mid: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', endpointId: 'perplexity-web', ep: 'Perplexity' },
  ] },
];
const state = (over = {}) => ({
  live: {
    modelGroups: groups,
    modelList: groups.flatMap((g) => g.models),
    defaultModel: 'claude-cli·claude-opus-4-8',
    chat: { model: 'claude-sonnet-4-6', endpointId: 'claude-cli' },
    ...over,
  },
});

const SONNET = 'claude-cli·claude-sonnet-4-6';
const count = (html, re) => (html.match(re) || []).length;

test('no pins: no PINNED group, two endpoint headers (structure unchanged)', () => {
  for (const pinnedModels of [undefined, [], ['ghost·nothing']]) {
    const html = renderModelSheet(state({ pinnedModels }));
    assert.doesNotMatch(html, /PINNED/);
    assert.equal(count(html, /class="m-model-ep"/g), 2);
  }
});

test('a pinned model renders a PINNED group first and still appears under its endpoint', () => {
  const html = renderModelSheet(state({ pinnedModels: [SONNET] }));
  const eps = [...html.matchAll(/class="m-model-ep">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(eps, ['PINNED', 'Claude CLI', 'Perplexity']);
  assert.equal(count(html, new RegExp(`data-act="mSetModel" data-arg="${SONNET}"`, 'g')), 2);
  assert.ok(html.indexOf(`data-act="mSetModel" data-arg="${SONNET}"`) < html.indexOf('class="m-model-ep">Claude CLI<'));
});

test('unresolved pins are skipped silently, resolvable ones in a mixed list still render', () => {
  assert.doesNotMatch(renderModelSheet(state({ pinnedModels: ['ghost·nothing'] })), /PINNED/);
  const mixed = renderModelSheet(state({ pinnedModels: ['ghost·nothing', SONNET] }));
  assert.match(mixed, /class="m-model-ep">PINNED</);
  assert.equal(count(mixed, new RegExp(`data-act="mSetModel" data-arg="${SONNET}"`, 'g')), 2);
});

test('every row has an mTogglePinModel button; pinned ones are on', () => {
  const html = renderModelSheet(state({ pinnedModels: [SONNET] }));
  const rows = count(html, /class="m-model-row/g);
  assert.equal(rows, 4);
  assert.equal(count(html, /data-act="mTogglePinModel"/g), rows);
  assert.equal(count(html, new RegExp(`class="mpin on" data-act="mTogglePinModel" data-arg="${SONNET}"`, 'g')), 2);
  assert.equal(count(html, /class="mpin on"/g), 2);
  assert.match(html, /class="mpin" data-act="mTogglePinModel" data-arg="claude-cli·claude-opus-4-8"/);
});

test('the pin button is its own nested target, before the star; the selected pinned model shows its check twice', () => {
  const html = renderModelSheet(state({ pinnedModels: [SONNET] }));
  const row = html.match(/<div class="m-model-row[^"]*" data-act="mSetModel" data-arg="claude-cli·claude-opus-4-8"[\s\S]*?<\/div>/)[0];
  assert.ok(row.indexOf('mTogglePinModel') < row.indexOf('mSetDefaultModel'));
  assert.equal(count(row, /data-act="mSetModel"/g), 1);
  assert.equal(count(html, /<polyline points="20 6 9 17 4 12"\/>/g), 2); // active SONNET in both places
});
