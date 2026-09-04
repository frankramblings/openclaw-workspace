import { test } from 'node:test';
import assert from 'node:assert';

// deeplink.js now statically imports api.js (for the clip action's POST
// /api/clip call), which reads `location.origin` at module load time --
// stub it before pulling deeplink.js in, dynamically, so the stub is in
// place first (a static import here would hoist ahead of the assignment
// below; same "browser shim" pattern as chat-usage.test.js). Deliberately
// NOT stubbing window/document: deeplink.js only auto-runs initDeepLinks()
// when both are present, and these tests only exercise its pure exports.
globalThis.location = { origin: 'http://localhost' };

const {
  planForAction, serializePending, parsePending, ACTION_PLANS,
  cleanedSearch, searchDispatchPlan, clipPlanFields,
} = await import('../deeplink.js');

// ---- planForAction ----------------------------------------------------

test('planForAction: new → fresh chat with focused composer', () => {
  const plan = planForAction('new');
  assert.equal(plan.newChat, true);
  assert.equal(plan.focus, 'input');
});

test('planForAction: search → runSearch without a new chat', () => {
  const plan = planForAction('search');
  assert.equal(plan.runSearch, true);
  assert.equal(plan.newChat, false);
});

test('planForAction: photo → fresh chat, unfocused, attach requested', () => {
  const plan = planForAction('photo');
  assert.equal(plan.newChat, true);
  assert.equal(plan.focus, 'none');
  assert.equal(plan.openAttach, true);
});

test('planForAction: inbox → openInbox without a new chat', () => {
  const plan = planForAction('inbox');
  assert.equal(plan.openInbox, true);
  assert.equal(plan.newChat, false);
});

// ---- clip action plan ---------------------------------------------------

test('planForAction: clip -> doClip without a new chat by default', () => {
  const plan = planForAction('clip');
  assert.equal(plan.doClip, true);
  assert.equal(plan.newChat, false);
  assert.equal(plan.openInbox, false);
  assert.equal(plan.runSearch, undefined);
});

test('clipPlanFields: mention=1 requests a fresh chat with the token queued', () => {
  const params = new URLSearchParams('action=clip&q=https://example.com/a&mention=1');
  assert.deepEqual(clipPlanFields(params), {
    clipUrl: 'https://example.com/a', mentionAfterClip: true, newChat: true,
  });
});

test('clipPlanFields: no mention param -> no new chat, still carries the URL', () => {
  const params = new URLSearchParams('action=clip&q=https://example.com/a');
  assert.deepEqual(clipPlanFields(params), {
    clipUrl: 'https://example.com/a', mentionAfterClip: false, newChat: false,
  });
});

test('clipPlanFields: mention=0 or anything but "1" behaves like no mention', () => {
  const params = new URLSearchParams('action=clip&q=https://example.com/a&mention=0');
  assert.equal(clipPlanFields(params).mentionAfterClip, false);
});

test('clipPlanFields: missing q -> empty clipUrl, never throws', () => {
  assert.deepEqual(clipPlanFields(new URLSearchParams('action=clip')), {
    clipUrl: '', mentionAfterClip: false, newChat: false,
  });
});

// initDeepLinks never mutates ACTION_PLANS directly — it spreads a shallow
// copy (`{ ...plan }`) before attaching request-specific fields (prefill,
// searchQuery, autosend). Pin that the shared table survives that pattern
// for every action it applies it to.
test('planForAction: copy-then-mutate pattern (as used by initDeepLinks) never touches ACTION_PLANS', () => {
  for (const action of ['new', 'photo', 'voice', 'search', 'clip']) {
    const before = JSON.stringify(ACTION_PLANS[action]);
    const copy = { ...planForAction(action) };
    copy.prefill = 'hello';
    copy.searchQuery = 'hello';
    copy.autosend = true;
    assert.equal(JSON.stringify(ACTION_PLANS[action]), before);
    assert.equal(ACTION_PLANS[action].prefill, undefined);
    assert.equal(ACTION_PLANS[action].searchQuery, undefined);
    assert.equal(ACTION_PLANS[action].autosend, undefined);
  }
});

// ACTION_PLANS and each plan entry are frozen — nothing (planForAction's
// caller included) has a legitimate reason to mutate the shared table;
// initDeepLinks always copies first (see the test above).
test('planForAction: ACTION_PLANS and its entries are frozen', () => {
  assert.equal(Object.isFrozen(ACTION_PLANS), true);
  for (const action of Object.keys(ACTION_PLANS)) {
    assert.equal(Object.isFrozen(ACTION_PLANS[action]), true, `${action} plan is not frozen`);
  }
  assert.throws(() => { ACTION_PLANS.new.newChat = false; });
  assert.throws(() => { ACTION_PLANS.bogus = { newChat: true }; });
});

test('planForAction: case-insensitive lookup', () => {
  assert.equal(planForAction('NEW'), ACTION_PLANS.new);
  assert.equal(planForAction('Search'), ACTION_PLANS.search);
});

test('planForAction: unknown or non-string → null', () => {
  assert.equal(planForAction('bogus'), null);
  assert.equal(planForAction(null), null);
  assert.equal(planForAction(undefined), null);
  assert.equal(planForAction(42), null);
});

// ---- pending-plan persistence (reload survival) ------------------------

const NOW = 1_700_000_000_000;

test('pending: serialize → parse roundtrips the plan', () => {
  const plan = { newChat: true, focus: 'input', prefill: 'what is 2+2', autosend: true };
  const parsed = parsePending(serializePending(plan, NOW), NOW + 5_000);
  assert.deepEqual(parsed, plan);
});

test('pending: stale record (older than freshness bound) is rejected', () => {
  const raw = serializePending({ newChat: true }, NOW);
  assert.equal(parsePending(raw, NOW + 121_000), null);
});

test('pending: record just inside the freshness bound is accepted', () => {
  const raw = serializePending({ newChat: true }, NOW);
  assert.deepEqual(parsePending(raw, NOW + 119_000), { newChat: true });
});

test('pending: clock-skewed record from the future is rejected', () => {
  const raw = serializePending({ newChat: true }, NOW + 60_000);
  assert.equal(parsePending(raw, NOW), null);
});

test('pending: garbage input → null, never throws', () => {
  assert.equal(parsePending(null, NOW), null);
  assert.equal(parsePending(undefined, NOW), null);
  assert.equal(parsePending('', NOW), null);
  assert.equal(parsePending('not json{', NOW), null);
  assert.equal(parsePending('42', NOW), null);
  assert.equal(parsePending('"string"', NOW), null);
  assert.equal(parsePending(JSON.stringify({ ts: NOW }), NOW), null);          // no plan
  assert.equal(parsePending(JSON.stringify({ plan: { newChat: true } }), NOW), null); // no ts
  assert.equal(parsePending(JSON.stringify({ plan: 'x', ts: NOW }), NOW), null);      // plan not object
});

// ---- cleanedSearch (URL param stripping) -------------------------------

test('cleanedSearch: strips action/q/autosend, preserves other params', () => {
  assert.equal(cleanedSearch('?action=search&q=cats&autosend=1&extra=2'), '?extra=2');
});

test('cleanedSearch: strips mention (clip-only), preserves other params', () => {
  assert.equal(cleanedSearch('?action=clip&q=https://example.com/a&mention=1&extra=2'), '?extra=2');
});

test('cleanedSearch: works without a leading "?"', () => {
  assert.equal(cleanedSearch('action=new&q=hi'), '');
});

test('cleanedSearch: nothing to strip leaves other params untouched', () => {
  assert.equal(cleanedSearch('?foo=1&bar=2'), '?foo=1&bar=2');
});

test('cleanedSearch: empty/no params → empty string', () => {
  assert.equal(cleanedSearch(''), '');
  assert.equal(cleanedSearch('?'), '');
});

test('cleanedSearch: only deep-link params → empty string (no trailing "?")', () => {
  assert.equal(cleanedSearch('?action=inbox'), '');
});

// ---- searchDispatchPlan (desktop convSearch merge poll) ----------------

test('searchDispatchPlan: convSearch already merged in → ready', () => {
  assert.equal(searchDispatchPlan({ convSearch: () => {} }, 0, 40), 'ready');
});

test('searchDispatchPlan: no actions object yet, budget remains → retry', () => {
  assert.equal(searchDispatchPlan(null, 0, 40), 'retry');
  assert.equal(searchDispatchPlan(undefined, 5, 40), 'retry');
});

test('searchDispatchPlan: actions present but convSearch not merged yet → retry', () => {
  assert.equal(searchDispatchPlan({ newChat: () => {} }, 10, 40), 'retry');
});

test('searchDispatchPlan: budget exhausted without convSearch → give-up', () => {
  assert.equal(searchDispatchPlan(null, 40, 40), 'give-up');
  assert.equal(searchDispatchPlan({}, 41, 40), 'give-up');
});

test('searchDispatchPlan: ready takes priority even at the budget edge', () => {
  assert.equal(searchDispatchPlan({ convSearch: () => {} }, 40, 40), 'ready');
});
