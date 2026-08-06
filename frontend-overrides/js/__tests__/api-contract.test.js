// Task 1.2: api.js failure contract.
//
// live/api.js's apiJson used to deliberately RESOLVE (not reject) on a 502/503
// response — a workaround for gateway-restart flakiness that backfired: every
// mutation caller that does `try { await apiJson(...); <mark success> } catch
// { <revert> }` took the SUCCESS branch on a 502, because there was nothing to
// catch. Concretely: live/email.js sendEmail closed the compose box and
// discarded the draft as "sent"; live/inbox.js item actions left cards
// dismissed though the server did nothing.
//
// The fix: apiJson throws an ApiError (carrying .status and the parsed .body)
// on ANY !res.ok, including 502/503. This file pins that contract, then pins
// one representative caller (email.js sendEmail) so a regression there is
// caught even if a future edit "fixes" api.js but re-breaks a caller.
import { test, mock } from 'node:test';
import assert from 'node:assert';

// api.js reads `location.origin` at module-load time.
globalThis.location = { origin: 'http://localhost' };

const { apiJson, apiDelete, ApiError } = await import('../redesign/live/api.js');

function fakeRes({ ok, status, json, text, contentType = 'application/json' }) {
  return {
    ok,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => (json !== undefined ? json : {}),
    text: async () => (text !== undefined ? text : ''),
  };
}

// ---- ApiError shape ---------------------------------------------------------

test('ApiError is a real Error carrying .status and the parsed .body', () => {
  const err = new ApiError(502, { error: 'bad gateway' }, '/api/x', 'POST');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 502);
  assert.deepStrictEqual(err.body, { error: 'bad gateway' });
});

// ---- apiJson throw behavior --------------------------------------------------

test('apiJson resolves with parsed JSON on a 2xx response', async () => {
  globalThis.fetch = mock.fn(async () => fakeRes({ ok: true, status: 200, json: { ok: true, id: 1 } }));
  try {
    const r = await apiJson('/api/x', { a: 1 });
    assert.deepStrictEqual(r, { ok: true, id: 1 });
  } finally {
    delete globalThis.fetch;
  }
});

test('apiJson throws ApiError on a 502 instead of silently resolving (the gateway-restart case)', async () => {
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 502, contentType: 'text/html', text: '<html>Bad Gateway</html>',
  }));
  try {
    await assert.rejects(
      () => apiJson('/api/items/action', { id: '1' }),
      (e) => e instanceof ApiError && e.status === 502,
    );
  } finally {
    delete globalThis.fetch;
  }
});

test('apiJson throws ApiError on a 503 too', async () => {
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 503, contentType: 'text/plain', text: 'Service Unavailable',
  }));
  try {
    await assert.rejects(
      () => apiJson('/api/x', {}),
      (e) => e instanceof ApiError && e.status === 503,
    );
  } finally {
    delete globalThis.fetch;
  }
});

test('apiJson throws ApiError on ordinary 4xx/5xx too (unchanged from before)', async () => {
  globalThis.fetch = mock.fn(async () => fakeRes({ ok: false, status: 404, json: { error: 'not found' } }));
  try {
    await assert.rejects(
      () => apiJson('/api/x', {}),
      (e) => e instanceof ApiError && e.status === 404,
    );
  } finally {
    delete globalThis.fetch;
  }
});

test('ApiError.body carries the parsed error payload so callers can branch on it (e.g. {detail})', async () => {
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 400, json: { detail: 'current password is wrong' },
  }));
  try {
    await assert.rejects(
      () => apiJson('/api/auth/change-password', {}),
      (e) => e instanceof ApiError && e.status === 400 && e.body && e.body.detail === 'current password is wrong',
    );
  } finally {
    delete globalThis.fetch;
  }
});

// ---- apiDelete throw behavior (Task 1.6) -------------------------------------
// apiDelete used to always resolve (even on a failed DELETE), the same bug
// apiJson had before Task 1.2. Now it throws ApiError on !res.ok too, same
// contract as apiJson.

test('apiDelete resolves with parsed JSON on a 2xx response', async () => {
  globalThis.fetch = mock.fn(async () => fakeRes({ ok: true, status: 200, json: { ok: true } }));
  try {
    const r = await apiDelete('/api/x/1');
    assert.deepStrictEqual(r, { ok: true });
  } finally {
    delete globalThis.fetch;
  }
});

test('apiDelete throws ApiError on a non-2xx response instead of silently resolving', async () => {
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 404, json: { detail: 'not found' },
  }));
  try {
    await assert.rejects(
      () => apiDelete('/api/x/1'),
      (e) => e instanceof ApiError && e.status === 404 && e.body && e.body.detail === 'not found',
    );
  } finally {
    delete globalThis.fetch;
  }
});

// ---- caller-behavior regression: live/email.js sendEmail --------------------
// Pins the exact bug from the audit: a 502 must NOT close compose / discard
// the draft / claim success. This only passes once apiJson actually throws
// above; email.js's own try/catch was already correct, so no change to
// email.js was needed once api.js's contract was fixed.

const { runtime } = await import('../redesign/live/runtime.js');
const emailMod = await import('../redesign/live/email.js');

test('sendEmail on a 502 keeps compose open with the draft intact and surfaces an error (no fake send)', async () => {
  const state = {
    composeOpen: true,
    composeTo: 'a@b.com',
    composeSubject: 'Hi',
    composeBody: 'draft text',
    composeInReplyTo: '',
  };
  runtime.state = state;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 502, contentType: 'text/html', text: '<html>Bad Gateway</html>',
  }));
  try {
    await emailMod.actions.sendEmail();
  } finally {
    delete globalThis.fetch;
  }
  assert.equal(state.composeOpen, true, 'compose must stay open on a failed send');
  assert.equal(state.composeTo, 'a@b.com', 'recipient must be preserved');
  assert.equal(state.composeSubject, 'Hi', 'subject must be preserved');
  assert.equal(state.composeBody, 'draft text', 'draft body must be preserved');
  assert.ok(state.inboxToast, 'a failure must be surfaced, not silently swallowed');
  assert.equal(state.inboxToast.msg, 'Could not send the email.');
});

test('sendEmail on a 2xx clears compose and does not toast an error', async () => {
  const state = {
    composeOpen: true,
    composeTo: 'a@b.com',
    composeSubject: 'Hi',
    composeBody: 'draft text',
    composeInReplyTo: '',
  };
  runtime.state = state;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => fakeRes({ ok: true, status: 200, json: { ok: true } }));
  try {
    await emailMod.actions.sendEmail();
  } finally {
    delete globalThis.fetch;
  }
  assert.equal(state.composeOpen, false, 'compose closes on a real success');
  assert.equal(state.composeBody, '', 'draft clears on a real success');
});

// ---- caller-behavior regression: live/inbox.js item actions -----------------
// Pins the second audit-confirmed bug: an inbox card's optimistic dismiss must
// revert (and the user must see a retry toast) when the server didn't actually
// act on it — not stay dismissed as if it had.

const inboxMod = await import('../redesign/live/inbox.js');

test('inbox archive on a 502 reverts the optimistic dismiss and shows a retry toast', async () => {
  const state = {
    dismissed: [],
    inboxApplying: null,
    inboxToast: null,
    live: { inbox: { items: [{ id: '42', source: 'gmail', meta: {} }] } },
  };
  runtime.state = state;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 502, contentType: 'text/html', text: '<html>Bad Gateway</html>',
  }));
  try {
    await inboxMod.actions.archive('42');
  } finally {
    delete globalThis.fetch;
  }
  assert.deepStrictEqual(state.dismissed, [], 'card must not stay dismissed when the server did nothing');
  assert.ok(state.inboxToast && /retry/i.test(state.inboxToast.msg), 'a retry toast must be surfaced');
});

test('inbox archive on a 2xx stays dismissed and does not toast a failure', async () => {
  const state = {
    dismissed: [],
    inboxApplying: null,
    inboxToast: null,
    live: { inbox: { items: [{ id: '42', source: 'gmail', meta: {} }] } },
  };
  runtime.state = state;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => fakeRes({ ok: true, status: 200, json: { ok: true, undoTs: 123 } }));
  try {
    await inboxMod.actions.archive('42');
  } finally {
    delete globalThis.fetch;
  }
  assert.deepStrictEqual(state.dismissed, ['42']);
  assert.equal(state.inboxToast, null);
});

// ---- caller-behavior regression: live/settings.js cronRun --------------------
// Pins the third audit-confirmed bug: cronRun alerted "Job triggered." after
// the catch swallowed any error — unconditionally, even when the trigger
// failed. Success must be confirmed before the success message shows.

const settingsMod = await import('../redesign/live/settings.js');

test('cronRun toasts success only after a confirmed 2xx', async () => {
  const state = { inboxToast: null };
  runtime.state = state;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => fakeRes({ ok: true, status: 200, json: { ok: true } }));
  try {
    await settingsMod.actions.cronRun('job-1');
  } finally {
    delete globalThis.fetch;
  }
  assert.equal(state.inboxToast && state.inboxToast.msg, 'Job triggered.');
});

test('cronRun on a 502 says it failed, not "Job triggered."', async () => {
  const state = { inboxToast: null };
  runtime.state = state;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 502, contentType: 'text/html', text: '<html>Bad Gateway</html>',
  }));
  try {
    await settingsMod.actions.cronRun('job-1');
  } finally {
    delete globalThis.fetch;
  }
  assert.ok(state.inboxToast, 'a failure must be surfaced');
  assert.doesNotMatch(state.inboxToast.msg, /Job triggered/);
});

test('changePassword surfaces the backend detail message on failure', async () => {
  const st = { pwCurrent: 'old', pwNew: 'newpassword1', pwConfirm: 'newpassword1', inboxToast: null };
  runtime.state = st;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 400, json: { detail: 'current password is wrong' },
  }));
  try {
    await settingsMod.actions.changePassword();
  } finally {
    delete globalThis.fetch;
  }
  assert.equal(st.inboxToast && st.inboxToast.msg, 'current password is wrong');
  assert.equal(st.pwCurrent, 'old', 'fields must not clear on a failed change');
});

test('exportData downloads the blob only on a 2xx and toasts on a server error (no error-page-as-.zip)', async () => {
  const state = { inboxToast: null };
  runtime.state = state;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => fakeRes({
    ok: false, status: 502, contentType: 'text/html', text: '<html>Bad Gateway</html>',
  }));
  const origCreate = globalThis.document && globalThis.document.createElement;
  // jsdom-free environment: stub just enough of `document` for the download
  // path to be reachable without exercising it (the res.ok check returns
  // before touching document at all on failure, which is exactly what this
  // test pins).
  globalThis.document = globalThis.document || { createElement: () => ({}), body: { appendChild() {}, } };
  try {
    await settingsMod.actions.exportData();
  } finally {
    delete globalThis.fetch;
    if (origCreate) globalThis.document.createElement = origCreate;
  }
  assert.equal(state.inboxToast && state.inboxToast.msg, 'Export failed — the server returned an error.');
});

// ---- dead actions removed (Task 1.6) -----------------------------------------
// Import Data, Danger-Zone wipes, and Add User POSTed to routes that never
// existed (404s silently swallowed). Pin that the actions are actually gone,
// not just unreachable from the UI.

test('wipe/addUser/importData actions no longer exist on the settings module', () => {
  assert.equal(settingsMod.actions.wipe, undefined);
  assert.equal(settingsMod.actions.addUser, undefined);
  assert.equal(settingsMod.actions.importData, undefined);
});
