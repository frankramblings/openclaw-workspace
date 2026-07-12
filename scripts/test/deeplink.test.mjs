import assert from 'node:assert/strict';
import { planForAction, ACTION_PLANS } from '../../frontend-overrides/js/deeplink.js';

assert.equal(planForAction('new').newChat, true);
assert.equal(planForAction('new').focus, 'input');
assert.equal(planForAction('photo').newChat, true);
assert.equal(planForAction('photo').openAttach, true);
assert.equal(planForAction('photo').focus, 'none');
assert.equal(planForAction('voice').newChat, true);
assert.equal(planForAction('voice').openAttach, false);
assert.equal(planForAction('inbox').openInbox, true);
assert.equal(planForAction('inbox').newChat, false);
assert.equal(planForAction('search').runSearch, true);
assert.equal(planForAction('search').newChat, false);
assert.equal(planForAction('search').openInbox, false);
assert.equal(planForAction('NEW').newChat, true);     // case-insensitive
assert.equal(planForAction('bogus'), null);
assert.equal(planForAction(undefined), null);
assert.equal(planForAction(''), null);

// initDeepLinks copies (`{ ...plan }`) before attaching per-request fields
// (prefill/searchQuery/autosend) — pin that the shared ACTION_PLANS entries
// stay pristine across that copy-then-mutate pattern, for every action that
// carries newChat or runSearch (the two branches initDeepLinks mutates).
for (const action of ['new', 'photo', 'voice', 'search']) {
  const before = JSON.stringify(ACTION_PLANS[action]);
  const copy = { ...planForAction(action) };
  copy.prefill = 'hello';
  copy.searchQuery = 'hello';
  copy.autosend = true;
  assert.equal(JSON.stringify(ACTION_PLANS[action]), before, `${action}: ACTION_PLANS mutated`);
  assert.equal(ACTION_PLANS[action].prefill, undefined, `${action}: prefill leaked onto ACTION_PLANS`);
}

console.log('deeplink planForAction: 24 assertions OK');
