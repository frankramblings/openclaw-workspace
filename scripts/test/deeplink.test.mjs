import assert from 'node:assert/strict';

// deeplink.js now statically imports api.js (for the clip action's POST
// /api/clip call), which reads `location.origin` at module load time --
// stub it before pulling deeplink.js in, dynamically, so the stub is in
// place first (a static import here would hoist ahead of the assignment
// below).
globalThis.location = { origin: 'http://localhost' };

const { planForAction, ACTION_PLANS, cleanedSearch, searchDispatchPlan } =
  await import('../../frontend-overrides/js/deeplink.js');

assert.equal(planForAction('new').newChat, true);
assert.equal(planForAction('new').focus, 'input');
assert.equal(planForAction('photo').newChat, true);
assert.equal(planForAction('photo').openAttach, true);
assert.equal(planForAction('photo').focus, 'none');
assert.equal(planForAction('voice').newChat, true);
assert.equal(planForAction('voice').openAttach, false);
// Task 3.3: no mic capture exists on either shell, so `voice` now lands the
// same as a plain new-chat-and-focus (like `new`) instead of a bare "open a
// fresh composer, mic button is showing" plan with no gesture to trigger it.
assert.equal(planForAction('voice').focus, 'input');
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

// ACTION_PLANS and each plan entry are frozen — initDeepLinks copies before
// mutating (above); nothing else has a legitimate reason to write to them.
assert.equal(Object.isFrozen(ACTION_PLANS), true);
for (const action of Object.keys(ACTION_PLANS)) {
  assert.equal(Object.isFrozen(ACTION_PLANS[action]), true, `${action} plan is not frozen`);
}
assert.throws(() => { ACTION_PLANS.new.newChat = false; });

// cleanedSearch: pure param-stripping helper backing initDeepLinks' URL cleanup.
assert.equal(cleanedSearch('?action=search&q=cats&autosend=1&extra=2'), '?extra=2');
assert.equal(cleanedSearch('?action=clip&q=https://example.com/a&mention=1&extra=2'), '?extra=2');
assert.equal(cleanedSearch('action=new&q=hi'), '');
assert.equal(cleanedSearch('?foo=1&bar=2'), '?foo=1&bar=2');
assert.equal(cleanedSearch(''), '');
assert.equal(cleanedSearch('?action=inbox'), '');

// searchDispatchPlan: pure poll-decision backing the desktop convSearch merge wait.
assert.equal(searchDispatchPlan({ convSearch: () => {} }, 0, 40), 'ready');
assert.equal(searchDispatchPlan(null, 0, 40), 'retry');
assert.equal(searchDispatchPlan({ newChat: () => {} }, 10, 40), 'retry');
assert.equal(searchDispatchPlan(null, 40, 40), 'give-up');
assert.equal(searchDispatchPlan({ convSearch: () => {} }, 40, 40), 'ready');

console.log('deeplink planForAction: 25 assertions OK');
console.log('deeplink cleanedSearch/searchDispatchPlan/frozen-plans: 16 assertions OK');
