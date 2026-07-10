import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';

const email = {
  subj: 'Q3 planning', from: 'Dana Hu', fromMail: 'dana@example.com', to: 'me',
  time: '2h', src: 'GMAIL', srcColor: '#fff', srcBg: '#333', unread: false,
  initials: 'DH', avBg: '#222', avFg: '#fff', body: ['First paragraph.'], attach: [],
};

const stateWith = (emails) => ({
  surface: 'email', selEmail: 0, emailQuery: '',
  live: { email: { emails } },
});

test('email reader never renders the hardcoded fake quoted reply', () => {
  const html = renderCenter(stateWith([email]));
  assert.doesNotMatch(html, /Alex Rivera/);
  assert.doesNotMatch(html, /alex@example\.com/);
  assert.doesNotMatch(html, /class="quote"/);
});

test('email surface shows an empty-state instead of reader chrome when no email exists', () => {
  const html = renderCenter(stateWith([]));
  assert.match(html, /reader-empty/);
  // no reply toolbar / reply bar for a nonexistent message
  assert.doesNotMatch(html, /data-act="composeReply"/);
  assert.doesNotMatch(html, /data-act="summarizeEmail"/);
});

test('email surface still renders the real message body when one is selected', () => {
  const html = renderCenter(stateWith([email]));
  assert.match(html, /First paragraph\./);
  assert.match(html, /data-act="composeReply"/);
});
