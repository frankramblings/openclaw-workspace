import { test } from 'node:test';
import assert from 'node:assert';
import { mEmailList, mEmailReader } from '../redesign/mobile/mobile-surfaces.js';

const email = {
  subj: 'Q3 planning', from: 'Dana Hu', time: '2h', src: 'GMAIL',
  srcColor: '#fff', srcBg: '#333', unread: false,
  initials: 'DH', avBg: '#222', avFg: '#fff', body: ['First paragraph.'],
};
const state = { selEmail: 0, live: { email: { emails: [email] } } };

// Every button in the mobile email surfaces must do something when tapped.
const deadButtons = (html) =>
  [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]).filter((b) => !b.includes('data-act='));

test('mobile email list + button opens the compose sheet', () => {
  const html = mEmailList(state);
  assert.match(html, /data-act="composeNew"/);
});

test('mobile email list has no dead buttons', () => {
  assert.deepEqual(deadButtons(mEmailList(state)), []);
});

test('mobile email reader has no dead buttons', () => {
  assert.deepEqual(deadButtons(mEmailReader(state)), []);
});
