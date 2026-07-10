import { test } from 'node:test';
import assert from 'node:assert';
import { mEmailList, mEmailReader } from '../redesign/mobile/mobile-surfaces.js';

const email = (subj, from) => ({
  subj, from, time: '2h', src: 'GMAIL', srcColor: '#fff', srcBg: '#333', unread: false,
  initials: 'DH', avBg: '#222', avFg: '#fff', body: ['First paragraph.'],
});

test('mobile email search is a real bound input', () => {
  const html = mEmailList({ selEmail: 0, live: { email: { emails: [email('A', 'B')] } } });
  assert.match(html, /<input[^>]*data-model="emailQuery"/);
});

test('mobile email search filters the list', () => {
  const s = { selEmail: 0, emailQuery: 'planning', live: { email: { emails: [email('Q3 planning', 'Dana'), email('Lunch?', 'Sam')] } } };
  const html = mEmailList(s);
  assert.match(html, /Q3 planning/);
  assert.doesNotMatch(html, /Lunch\?/);
});

test('mobile email list shows an empty state instead of a blank void', () => {
  const html = mEmailList({ selEmail: 0, live: { email: { emails: [] } } });
  assert.match(html, /m-mail-empty/);
});

test('mobile email reader renders every attachment, not just the first', () => {
  const m = { ...email('Docs', 'Dana'), attach: [{ name: 'a.pdf', size: '1 MB' }, { name: 'b.png', size: '2 MB' }] };
  const html = mEmailReader({ selEmail: 0, live: { email: { emails: [m] } } });
  assert.match(html, /a\.pdf/);
  assert.match(html, /b\.png/);
});
