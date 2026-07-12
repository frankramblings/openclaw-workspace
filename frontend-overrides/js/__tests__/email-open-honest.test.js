import { test } from 'node:test';
import assert from 'node:assert';

// live/email.js imports api.js, which reads `location.origin` at module-eval
// time — set the global before the dynamic import (same pattern as
// calendar-honest.test.js) so a plain `node --test` run (no DOM) doesn't
// throw on load.
globalThis.location = { origin: 'http://localhost' };
const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/email.js');

function jsonRes(obj, ok = true) {
  return { ok, status: ok ? 200 : 502, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function freshState(emails) {
  const state = { selEmail: 0, live: { email: { emails, current: undefined } } };
  runtime.state = state;
  runtime.render = () => {};
  return state;
}

test('openAt: a successful open marks the item read and optimistically clears its unread dot', async () => {
  const emails = [{ uid: '5', subj: 'Hi', unread: true }];
  freshState(emails);
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts && opts.method });
    if (String(url).includes('/api/email/read/')) return jsonRes({ subject: 'Hi', uid: '5' });
    if (String(url).includes('/api/email/mark-read/')) return jsonRes({ ok: true });
    return jsonRes({});
  };
  await actions.selEmail(0);
  assert.equal(emails[0].unread, false, 'optimistic clear on the list row');
  const markCall = calls.find((c) => c.url.includes('/api/email/mark-read/5'));
  assert.ok(markCall, 'fired the mark-read route');
  assert.equal(markCall.method, 'POST');
  delete globalThis.fetch;
});

test('openAt: mark-read is never called for an already-read item', async () => {
  const emails = [{ uid: '9', subj: 'Old news', unread: false }];
  freshState(emails);
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/email/read/')) return jsonRes({ subject: 'Old news', uid: '9' });
    return jsonRes({});
  };
  await actions.selEmail(0);
  assert.ok(!calls.some((u) => u.includes('/api/email/mark-read/')));
  delete globalThis.fetch;
});

test('openAt: a failed mark-read is silent and does NOT revert the optimistic unread clear', async () => {
  const emails = [{ uid: '6', subj: 'Hi', unread: true }];
  freshState(emails);
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/email/read/')) return jsonRes({ subject: 'Hi', uid: '6' });
    if (String(url).includes('/api/email/mark-read/')) return jsonRes({ error: 'boom' }, false);
    return jsonRes({});
  };
  await actions.selEmail(0);
  // let the fire-and-forget mark-read rejection settle before asserting.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(emails[0].unread, false, 'never faked back to unread on a mark-read failure');
  delete globalThis.fetch;
});

test('openAt: stale-response guard — a slow-to-resolve older open cannot clobber a newer selection', async () => {
  const emails = [
    { uid: '1', subj: 'A', unread: false },
    { uid: '2', subj: 'B', unread: false },
  ];
  freshState(emails);
  const pending = {};
  globalThis.fetch = async (url) => {
    const m = String(url).match(/\/api\/email\/read\/(\d+)/);
    if (m) {
      const uid = m[1];
      pending[uid] = pending[uid] || deferred();
      return pending[uid].promise;
    }
    return jsonRes({ ok: true });
  };

  const pA = actions.selEmail(0); // opens uid 1 ("A") first
  const pB = actions.selEmail(1); // then opens uid 2 ("B") — supersedes A

  // B (the newer request) resolves first…
  pending['2'].resolve(jsonRes({ subject: 'B', uid: '2' }));
  await pB;
  assert.equal(runtime.state.live.email.current.subj, 'B');

  // …then A's late response finally arrives. It must not overwrite B.
  pending['1'].resolve(jsonRes({ subject: 'A', uid: '1' }));
  await pA;
  assert.equal(runtime.state.live.email.current.subj, 'B', "A's stale response must not clobber B's reader body");
  delete globalThis.fetch;
});
