import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';
import { mEmailReader } from '../redesign/mobile/mobile-surfaces.js';

// An email that arrived with a METHOD:REQUEST .ics can be answered straight
// from the reader (POST /api/email/rsvp/{uid}). Anything else must show no
// RSVP row at all, so the buttons never imply an action the backend would 404.
const base = {
  subj: 'Invitation: Sync @ Tue', from: 'Boss', fromMail: 'boss@example.com',
  to: 'me', time: '2h', src: 'GMAIL', srcColor: '#fff', srcBg: '#333',
  unread: false, initials: 'B', avBg: '#222', avFg: '#fff',
  body: ['When: Tue 10:00'], attach: [], uid: '42', folder: 'INBOX',
};
const invite = { method: 'REQUEST', uid: 'abc-123@google.com', summary: 'Sync' };
const withInvite = { ...base, invite };
const noInvite = { ...base, invite: null };
const state = (email) => ({
  surface: 'email', selEmail: 0, emailQuery: '',
  live: { email: { emails: [email], current: email } },
});

const rsvpTags = (html) => html.match(/<button[^>]*data-act="emailRsvp"[^>]*>[^<]*<\/button>/g) || [];

for (const [name, render] of [['desktop', renderCenter], ['mobile', mEmailReader]]) {
  test(`${name} reader: REQUEST invite gets Accept / Maybe / Decline`, () => {
    const tags = rsvpTags(render(state(withInvite)));
    assert.equal(tags.length, 3);
    assert.match(tags.join(''), /Accept<\/button>/);
    assert.match(tags.join(''), /Maybe<\/button>/);
    assert.match(tags.join(''), /Decline<\/button>/);
    assert.match(tags[0], /data-arg="42\|INBOX\|accepted"/);
    assert.match(tags[1], /data-arg="42\|INBOX\|tentative"/);
    assert.match(tags[2], /data-arg="42\|INBOX\|declined"/);
    assert.doesNotMatch(tags.join(''), /—/, 'no em dashes in the RSVP row');
  });

  test(`${name} reader: no RSVP row without a REQUEST invite`, () => {
    assert.equal(rsvpTags(render(state(noInvite))).length, 0);
    const reply = { ...base, invite: { ...invite, method: 'REPLY' } };
    assert.equal(rsvpTags(render(state(reply))).length, 0);
  });
}
