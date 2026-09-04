// Fix round 1 (review, Important 1): live/library.js's clipUrl action needs
// an in-flight guard -- without one, two rapid clicks on the "Clip URL"
// button each fire their own concurrent POST /api/clip for the same URL (a
// read-modify-write race on the backend's version_count, and one toast per
// click). This file drives the real action through a mocked fetch/DOM.
//
// live/library.js pulls in document-editor.js transitively (for docActions),
// which is DOM/Toast-UI-heavy at the level of its ACTIONS but -- per
// document-editor.test.js's own banner comment -- "imports cleanly under
// Node given a few minimal browser shims ... nothing else executes until a
// function is actually called". Reusing that same shim set here (plus
// window.prompt, which clipUrl itself calls). The mocked /api/clip response
// below deliberately omits `document.id` so docActions.openDoc is never
// invoked -- exercising that DOM-heavy path is exactly what
// document-editor.test.js's own tests avoid, for the same reason.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost', protocol: 'http:', host: 'localhost' };
globalThis.document = {
  querySelector: () => null,
  getElementById: () => null,
  createElement: () => ({
    style: {}, addEventListener() {}, setAttribute() {}, append() {}, appendChild() {},
    classList: { add() {}, remove() {} },
    remove() {},
    querySelector(sel) {
      if (sel === '.oc-toast-msg') return { set textContent(_v) {} };
      return null;
    },
  }),
  head: { appendChild() {} },
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
  documentElement: { style: { setProperty() {} }, classList: { contains: () => false } },
  addEventListener() {},
  activeElement: null,
};
globalThis.window = { addEventListener() {}, innerWidth: 1200, toastui: null, prompt: () => 'https://example.com/a' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 1;

const { actions } = await import('../redesign/live/library.js');

function jsonRes(status, obj) {
  return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) };
}

test('clipUrl: two rapid calls before the first resolves produce exactly one fetch', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    // No document.id -> docActions.openDoc is never reached (see banner).
    return jsonRes(200, { ok: true, document: { title: 'Example' }, mention: '@[Example](doc:x)', meta: {} });
  };
  globalThis.window.prompt = () => 'https://example.com/a';

  const p1 = actions.clipUrl();
  const p2 = actions.clipUrl(); // fired while p1 is still pending, same as a rapid second click
  await Promise.all([p1, p2]);

  assert.equal(fetchCalls, 1, 'the second concurrent call must be a no-op, not a second POST');
});

test('clipUrl: the guard clears after completion, so a later call fires its own fetch', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return jsonRes(200, { ok: true, document: { title: 'Example' }, mention: '@[Example](doc:x)', meta: {} });
  };
  globalThis.window.prompt = () => 'https://example.com/b';

  await actions.clipUrl();
  await actions.clipUrl();

  assert.equal(fetchCalls, 2, 'sequential (non-overlapping) calls are each real requests');
});

test('clipUrl: a rejected fetch still clears the in-flight guard (finally)', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network down'); };
  globalThis.window.prompt = () => 'https://example.com/c';

  await actions.clipUrl(); // fails, caught internally by clipUrl's own try/catch
  await actions.clipUrl(); // must not be swallowed by a stuck guard

  assert.equal(fetchCalls, 2);
});

test('clipUrl: a failure toasts the mapped message instead of a window.alert', async () => {
  // Final review, Minor 11: the Library button was the only clip entry point
  // that reported failures through a modal alert.
  const alerts = [];
  const toasted = [];
  globalThis.window.alert = (m) => { alerts.push(m); };
  const realCreate = globalThis.document.createElement;
  globalThis.document.createElement = () => ({
    style: {}, addEventListener() {}, setAttribute() {}, append() {}, appendChild() {},
    classList: { add() {}, remove() {} },
    remove() {},
    querySelector(sel) {
      if (sel === '.oc-toast-msg') return { set textContent(v) { toasted.push(v); } };
      return null;
    },
  });
  globalThis.fetch = async () => jsonRes(400, { ok: false, error: 'bad_url', detail: 'nope' });
  globalThis.window.prompt = () => 'https://example.com/d';

  try {
    await actions.clipUrl();
  } finally {
    globalThis.document.createElement = realCreate;
  }

  assert.deepEqual(alerts, [], 'no modal alert');
  assert.equal(toasted.length, 1);
  assert.match(toasted[0], /web address/);
});
