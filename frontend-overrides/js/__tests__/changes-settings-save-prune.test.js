// Task 9 fix round 1 (Important 1) — Settings > Changes: changesSavePrune
// must not wipe the saved prune list when the textarea was never touched.
//
// changesSavePrune lives in live/settings.js (not the pure changes-settings.js
// module), so it needs a network call and DOM/browser shims to exercise —
// same minimal-shim harness chat-usage.test.js uses (live/settings.js imports
// runtime.js, api.js — which reads `location.origin` at import time — and
// terminal.js).
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null, documentElement: { style: {} } };

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/settings.js');

const jsonRes = (obj) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const drainMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

function freshState(prune_dirs) {
  return {
    live: {
      changesSettings: {
        config: { roots: ['/home/frank/meetings'], prune_dirs, max_bytes: 262144 },
        stats: { blobs: 0, blob_bytes: 0, roots: [] },
        saving: false, error: null, rebuild: { running: false },
      },
    },
  };
}

test('Save prune list on an untouched textarea sends no request and does not wipe prune_dirs', async () => {
  const state = freshState(['.git', 'tmp']);
  runtime.state = state;
  runtime.render = () => {};
  const calls = [];
  globalThis.fetch = (url, opts) => { calls.push({ url: String(url), method: (opts && opts.method) || 'GET' }); return Promise.resolve(jsonRes({ ok: true })); };
  try {
    // state.changesPruneDraft is never set here — mirrors clicking "Save prune
    // list" without ever typing in the textarea.
    await actions.changesSavePrune();
    await drainMicrotasks();

    assert.equal(calls.length, 0, 'no network call at all — a no-op, not a guess');
    assert.deepEqual(state.live.changesSettings.config.prune_dirs, ['.git', 'tmp'],
      'the saved prune list in state is untouched');
  } finally {
    delete globalThis.fetch;
  }
});

test('Save prune list after typing sends the parsed draft as prune_dirs', async () => {
  const state = freshState(['.git', 'tmp']);
  state.changesPruneDraft = '.git\nnode_modules\n\n  \nvenv ';
  runtime.state = state;
  runtime.render = () => {};
  const calls = [];
  globalThis.fetch = (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: String(url), method, body: opts && opts.body });
    if (String(url).includes('/api/changes/config') && method === 'PUT') {
      return Promise.resolve(jsonRes({ ok: true, config: { roots: [], prune_dirs: ['.git', 'node_modules', 'venv'], max_bytes: 262144 } }));
    }
    if (String(url).includes('/api/changes/config')) return Promise.resolve(jsonRes({ ok: true, config: { roots: [], prune_dirs: ['.git', 'node_modules', 'venv'], max_bytes: 262144 } }));
    if (String(url).includes('/api/changes/stats')) return Promise.resolve(jsonRes({ ok: true, blobs: 0, blob_bytes: 0, roots: [], rebuild: { running: false } }));
    return Promise.resolve(jsonRes({ ok: true }));
  };
  try {
    await actions.changesSavePrune();
    await drainMicrotasks();

    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/changes/config'));
    assert.ok(put, 'a PUT to /api/changes/config was sent');
    const body = JSON.parse(put.body);
    assert.deepEqual(body.prune_dirs, ['.git', 'node_modules', 'venv'],
      'blank lines dropped, entries trimmed, in typed order');
  } finally {
    delete globalThis.fetch;
  }
});
