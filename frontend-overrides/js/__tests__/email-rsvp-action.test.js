import { test } from 'node:test';
import assert from 'node:assert';

// Same load dance as email-open-honest.test.js: api.js reads location.origin
// at module-eval time.
globalThis.location = { origin: 'http://localhost' };
const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/email.js');

function jsonRes(obj, ok = true, status = 200) {
  return { ok, status, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) };
}

function freshState() {
  const emails = [{ uid: '42', subj: 'Invitation: Sync', unread: false }];
  const state = { selEmail: 0, live: { email: { emails, current: { uid: '42', invite: { method: 'REQUEST' } } } } };
  runtime.state = state;
  runtime.render = () => {};
  return state;
}

test('emailRsvp: posts the response, drops the answered message and reloads the list', async () => {
  const state = freshState();
  state.mReader = true;
  const calls = [];
  // The backend files the message on success, so a re-read of the old uid 404s.
  // The reader must not fall back to the stale invite when that happens.
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts && opts.method, body: opts && opts.body });
    if (String(url).includes('/api/email/rsvp/')) return jsonRes({ ok: true, status: 'accepted' });
    if (String(url).includes('/api/email/read/')) return jsonRes({ detail: 'not found' }, false, 404);
    if (String(url).includes('/api/email/list')) return jsonRes({ emails: [{ uid: '77', subject: 'Other', date: '' }] });
    return jsonRes({});
  };
  await actions.emailRsvp('42|INBOX|accepted');
  const post = calls.find((c) => c.url.includes('/api/email/rsvp/'));
  assert.ok(post, 'RSVP posted');
  assert.equal(post.method, 'POST');
  assert.match(post.url, /\/api\/email\/rsvp\/42/);
  assert.deepEqual(JSON.parse(post.body), { rsvp: 'accepted', folder: 'INBOX' });
  assert.ok(calls.some((c) => c.url.includes('/api/email/list')), 'list reloaded');
  assert.equal(state.live.email.current, undefined, 'the answered invite is gone from the reader');
  assert.deepEqual(state.live.email.emails.map((e) => e.uid), ['77'], 'list shows what is left');
  assert.equal(state.mReader, false, 'mobile falls back to the list');
  assert.match(state.inboxToast.msg, /Accept/i);
});

test('emailRsvp: decodes each arg field', async () => {
  freshState();
  let body = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/email/rsvp/')) { body = JSON.parse(opts.body); return jsonRes({ ok: true }); }
    return jsonRes({ emails: [] });
  };
  await actions.emailRsvp(['42', '[Gmail]/All|Mail', 'tentative'].map(encodeURIComponent).join('|'));
  assert.deepEqual(body, { rsvp: 'tentative', folder: '[Gmail]/All|Mail' });
});

test('emailRsvp: a failed send toasts and does not claim success', async () => {
  const state = freshState();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/email/rsvp/')) return jsonRes({ ok: false, error: 'nope' }, false, 502);
    return jsonRes({ subject: 'Invitation: Sync', uid: '42' });
  };
  await actions.emailRsvp('42|INBOX|declined');
  assert.match(state.inboxToast.msg, /Could ?n.t send/i);
});

test('emailRsvp: ignores a malformed arg instead of posting a guess', async () => {
  freshState();
  let posted = false;
  globalThis.fetch = async (url) => { if (String(url).includes('rsvp')) posted = true; return jsonRes({}); };
  await actions.emailRsvp('42|INBOX|maybe-ish');
  await actions.emailRsvp('');
  assert.equal(posted, false);
});
