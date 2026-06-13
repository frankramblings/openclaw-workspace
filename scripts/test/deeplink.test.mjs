import assert from 'node:assert/strict';
import { planForAction } from '../../frontend-overrides/js/deeplink.js';

assert.equal(planForAction('new').newChat, true);
assert.equal(planForAction('new').focus, 'input');
assert.equal(planForAction('photo').newChat, true);
assert.equal(planForAction('photo').openAttach, true);
assert.equal(planForAction('photo').focus, 'none');
assert.equal(planForAction('voice').newChat, true);
assert.equal(planForAction('voice').openAttach, false);
assert.equal(planForAction('inbox').openInbox, true);
assert.equal(planForAction('inbox').newChat, false);
assert.equal(planForAction('NEW').newChat, true);     // case-insensitive
assert.equal(planForAction('bogus'), null);
assert.equal(planForAction(undefined), null);
assert.equal(planForAction(''), null);

console.log('deeplink planForAction: 13 assertions OK');
