// Pinned models: state.live.pinnedModels (ordered composite ids) is loaded by
// loadModelOptions from GET /api/pinned-models and toggled by togglePinModel
// (optimistic, rolled back + toast on POST failure). Browser shims per
// redesign-model-cross-pair.test.js.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');

const OPUS = 'claude-cli·claude-opus-4-8';
const LIST = [
  { id: OPUS, mid: 'claude-opus-4-8', name: 'Claude Opus 4.8', endpointId: 'claude-cli', ep: 'Claude CLI' },
  { id: 'openai·gpt-5.5', mid: 'gpt-5.5', name: 'GPT-5.5', endpointId: 'openai', ep: 'ChatGPT' },
];

const jsonRes = (obj, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

// Runs fn with runtime.state = s, a recording fetch, and a render counter.
async function withEnv(s, route, fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  const priorState = runtime.state;
  const priorRender = runtime.render;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return route(String(url), opts);
  };
  runtime.state = s;
  runtime.render = () => {};
  try { return await fn(calls); } finally {
    globalThis.fetch = origFetch;
    runtime.state = priorState;
    runtime.render = priorRender;
  }
}

const pinCalls = (calls) => calls.filter((c) => c.url.includes('/api/pinned-models') && c.opts.method === 'POST');

test('loadModelOptions populates pinnedModels as composite ids, in server order', async () => {
  const s = { live: { modelList: LIST, modelGroups: [{}] } };
  await withEnv(s, (url) => (url.includes('/api/pinned-models')
    ? jsonRes({ items: [{ model: 'claude-opus-4-8', endpoint_id: 'claude-cli' }] })
    : jsonRes({})), async () => {
    await actions.loadModelOptions();
  });
  assert.deepEqual(s.live.pinnedModels, [OPUS]);
});

test('a failed pinned-models GET leaves pinnedModels empty and does not set modelsFailed', async () => {
  const s = { live: { modelList: LIST, modelGroups: [{}] } };
  await withEnv(s, (url) => (url.includes('/api/pinned-models')
    ? Promise.reject(new Error('boom'))
    : jsonRes({})), async () => {
    await actions.loadModelOptions();
  });
  assert.deepEqual(s.live.pinnedModels, []);
  assert.notEqual(s.live.modelsFailed, true);
});

test('togglePinModel pins optimistically and POSTs pinned:true, then pinned:false to unpin', async () => {
  const s = { live: { modelList: LIST, pinnedModels: [] } };
  await withEnv(s, () => jsonRes({ ok: true }), async (calls) => {
    const p = actions.togglePinModel(OPUS);
    assert.deepEqual(s.live.pinnedModels, [OPUS], 'optimistic: updated before the POST settles');
    await p;
    const posts = pinCalls(calls);
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].opts.body), { model: 'claude-opus-4-8', endpoint_id: 'claude-cli', pinned: true });

    await actions.togglePinModel(OPUS);
    assert.deepEqual(s.live.pinnedModels, []);
    const posts2 = pinCalls(calls);
    assert.equal(posts2.length, 2);
    assert.deepEqual(JSON.parse(posts2[1].opts.body), { model: 'claude-opus-4-8', endpoint_id: 'claude-cli', pinned: false });
  });
});

test('togglePinModel appends new pins after existing ones', async () => {
  const s = { live: { modelList: LIST, pinnedModels: [OPUS] } };
  await withEnv(s, () => jsonRes({ ok: true }), async () => {
    await actions.togglePinModel('openai·gpt-5.5');
  });
  assert.deepEqual(s.live.pinnedModels, [OPUS, 'openai·gpt-5.5']);
});

test('a rejected POST reverts the list to its previous value', async () => {
  const s = { live: { modelList: LIST, pinnedModels: ['openai·gpt-5.5'] } };
  await withEnv(s, () => jsonRes({ detail: 'nope' }, false), async () => {
    await actions.togglePinModel(OPUS);
  });
  assert.deepEqual(s.live.pinnedModels, ['openai·gpt-5.5']);
});

test('togglePinModel never selects the model or closes the menu', async () => {
  const s = {
    modelMenuOpen: true,
    live: { modelList: LIST, pinnedModels: [], chat: { model: 'gpt-5.5', endpointId: 'openai', thread: [] } },
  };
  await withEnv(s, () => jsonRes({ ok: true }), async (calls) => {
    await actions.togglePinModel(OPUS);
    assert.equal(calls.filter((c) => c.opts.method === 'PATCH').length, 0, 'no session PATCH');
  });
  assert.equal(s.modelMenuOpen, true);
  assert.equal(s.live.chat.model, 'gpt-5.5');
  assert.equal(s.live.chat.endpointId, 'openai');
});

test('ids not in the loaded catalog are ignored (no state change, no POST)', async () => {
  const s = { live: { modelList: LIST, pinnedModels: [] } };
  await withEnv(s, () => jsonRes({ ok: true }), async (calls) => {
    await actions.togglePinModel('ghost·nothing');
    await actions.togglePinModel('');
    assert.equal(pinCalls(calls).length, 0);
  });
  assert.deepEqual(s.live.pinnedModels, []);
});

test('mTogglePinModel delegates to togglePinModel and leaves the sheet open', async () => {
  const { mobileActions } = await import('../redesign/mobile/mobile-app.js');
  const s = { live: {}, mModelSheetOpen: true };
  const seen = [];
  const prior = runtime.actions;
  runtime.actions = { togglePinModel: (id) => { seen.push(id); } };
  try {
    mobileActions(s).mTogglePinModel(OPUS);
  } finally {
    runtime.actions = prior;
  }
  assert.deepEqual(seen, [OPUS]);
  assert.equal(s.mModelSheetOpen, true);
});
