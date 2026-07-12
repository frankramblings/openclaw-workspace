import { test } from 'node:test';
import assert from 'node:assert';
import { planForAction, serializePending, parsePending, ACTION_PLANS } from '../deeplink.js';

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

// initDeepLinks never mutates ACTION_PLANS directly — it spreads a shallow
// copy (`{ ...plan }`) before attaching request-specific fields (prefill,
// searchQuery, autosend). Pin that the shared table survives that pattern
// for every action it applies it to.
test('planForAction: copy-then-mutate pattern (as used by initDeepLinks) never touches ACTION_PLANS', () => {
  for (const action of ['new', 'photo', 'voice', 'search']) {
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
