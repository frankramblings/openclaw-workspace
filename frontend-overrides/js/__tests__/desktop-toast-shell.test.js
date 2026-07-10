import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter, inboxToastHtml } from '../redesign/surfaces.js';

test('inboxToastHtml renders the toast standalone (for the desktop shell)', () => {
  const html = inboxToastHtml({ inboxToast: { msg: 'Something broke' } });
  assert.match(html, /inbox-toast/);
  assert.match(html, /Something broke/);
  assert.match(html, /data-act="dismissToast"/);
});

test('inboxToastHtml is empty without a toast', () => {
  assert.equal(inboxToastHtml({}), '');
});

test('the toast no longer lives inside the inbox surface (shell renders it)', () => {
  const s = { surface: 'inbox', dismissed: [], inboxToast: { msg: 'Boom' }, live: { inbox: { items: [] } } };
  assert.doesNotMatch(renderCenter(s), /inbox-toast/);
});
