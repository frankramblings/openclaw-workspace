import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';
import { mEmailReader } from '../redesign/mobile/mobile-surfaces.js';

// The download backend is a stub (out of scope) — attachment chips must read
// as plain metadata, not a fake button. No click-affordance class, no
// data-act, no button semantics, and an honest tooltip explaining why.
const email = {
  subj: 'Q3 planning', from: 'Dana Hu', fromMail: 'dana@example.com', to: 'me',
  time: '2h', src: 'GMAIL', srcColor: '#fff', srcBg: '#333', unread: false,
  initials: 'DH', avBg: '#222', avFg: '#fff', body: ['First paragraph.'],
  attach: [{ name: 'deck.pdf', size: '1.2 MB' }],
};
const state = (surface) => ({
  surface, selEmail: 0, emailQuery: '',
  live: { email: { emails: [email], current: email } },
});

test('desktop attachment chip: no button/clickable affordance, honest tooltip', () => {
  const html = renderCenter(state('email'));
  const m = html.match(/<div class="attach[^>]*>[\s\S]*?deck\.pdf/);
  assert.ok(m, 'attachment chip rendered');
  const tag = m[0];
  assert.doesNotMatch(tag, /\bocbtn\b/, 'no hover/click-feedback class');
  assert.doesNotMatch(tag, /data-act=/, 'no click handler wired');
  assert.doesNotMatch(tag, /role="button"/);
  assert.doesNotMatch(tag, /tabindex=/);
  assert.match(tag, /title="attachment download not yet available"/);
  assert.match(tag, /cursor:\s*default/, 'no pointer cursor implying it is clickable');
});

test('mobile attachment chip: no button/clickable affordance, honest tooltip', () => {
  const html = mEmailReader(state('email'));
  const m = html.match(/<div class="m-attach"[^>]*>[\s\S]*?deck\.pdf/);
  assert.ok(m, 'attachment chip rendered');
  const tag = m[0];
  assert.doesNotMatch(tag, /data-act=/);
  assert.doesNotMatch(tag, /role="button"/);
  assert.doesNotMatch(tag, /tabindex=/);
  assert.match(tag, /title="attachment download not yet available"/);
  assert.match(tag, /cursor:\s*default/);
});
