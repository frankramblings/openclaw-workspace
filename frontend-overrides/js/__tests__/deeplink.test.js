import { test } from 'node:test';
import assert from 'node:assert';

// deeplink.js now statically imports api.js (for the clip action's POST
// /api/clip call), which reads `location.origin` at module load time --
// stub it before pulling deeplink.js in, dynamically, so the stub is in
// place first (a static import here would hoist ahead of the assignment
// below; same "browser shim" pattern as chat-usage.test.js). Deliberately
// NOT stubbing window/document at import time: deeplink.js only auto-runs
// initDeepLinks() when both are present at MODULE LOAD, and neither is set
// yet here, so it stays a no-op even though some tests below (applyPlan's
// clip-failure DOM branch) set globalThis.document afterward, per-test.
globalThis.location = { origin: 'http://localhost' };

const {
  planForAction, serializePending, parsePending, ACTION_PLANS,
  cleanedSearch, searchDispatchPlan, clipPlanFields, applyPlan,
} = await import('../deeplink.js');
const { runtime } = await import('../redesign/live/runtime.js');

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

// ---- applyPlan: clip failure must never clobber an unsent draft ---------
//
// Fix round 1: the original catch branch always did
// `plan.focus = 'input'; plan.prefill = plan.clipUrl` on a failed clip, even
// without mention=1 -- newChat stays false there, so that composer is
// whatever surface the user was already on, and the blind prefill silently
// overwrote an unsent draft. Now: only touch the composer when it's empty;
// otherwise leave it (and focus) untouched. mention=1 keeps forcing a fresh
// (guaranteed-empty) chat, unaffected by this fix.

function _fakeInput(initialValue) {
  return {
    value: initialValue,
    focused: false,
    focus() { this.focused = true; },
    dispatchEvent() {},
    setSelectionRange() {},
  };
}

function _jsonRes(obj, ok = true, status = 200) {
  return {
    ok, status,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

// Task 6: a failed non-mention clip now toasts clipErrorMessage(e) (live/chat.js's
// exported toast()) instead of the placeholder console.warn. toast() reaches for
// document.getElementById/createElement/body — this document stub adds those,
// on top of the existing `querySelector: () => input` composer lookup, and
// captures what toast() writes into `.oc-toast-msg` the same way
// redesign-edit-message.test.js's fake DOM does (toast() isn't itself exported;
// its writes are the only observable signal). requestAnimationFrame is stubbed
// too, matching that same file's shim set — without it toast()'s catch-all
// would still swallow the ReferenceError, but real code exercises the real
// branch this way.
function _fakeToastDocument(composerInput) {
  const toastMessages = [];
  let toastHost = null;
  function makeFakeEl() {
    return {
      className: '', id: '', style: {},
      classList: { add() {}, remove() {} },
      appendChild() {},
      querySelector(sel) {
        if (sel === '.oc-toast-msg') return { set textContent(v) { toastMessages.push(v); } };
        return null;
      },
      addEventListener() {},
      remove() {},
    };
  }
  const doc = {
    querySelector: () => composerInput,
    getElementById: (id) => (id === 'oc-toast-host' ? toastHost : null),
    createElement: () => makeFakeEl(),
    body: { appendChild: (child) => { toastHost = child; } },
  };
  return { doc, toastMessages };
}

test('applyPlan: failed clip (no mention) leaves an existing draft untouched', async () => {
  const input = _fakeInput('a message I was already typing');
  const { doc, toastMessages } = _fakeToastDocument(input);
  globalThis.document = doc;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.fetch = async () => _jsonRes({ ok: false, error: 'fetch_failed', detail: 'could not reach that host' }, false, 502);
  const plan = { doClip: true, clipUrl: 'https://example.com/a', mentionAfterClip: false, newChat: false, focus: 'none', openAttach: false, openInbox: false };
  await applyPlan(plan);
  assert.equal(input.value, 'a message I was already typing');
  assert.equal(input.focused, false);
  assert.equal(plan.focus, 'none'); // untouched -- shared focus block never ran
  assert.deepEqual(toastMessages, ['Could not reach that page. Try again in a moment.']);
});

test('applyPlan: failed clip (no mention) prefills an empty composer with the URL', async () => {
  const input = _fakeInput('');
  const { doc, toastMessages } = _fakeToastDocument(input);
  globalThis.document = doc;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.fetch = async () => { throw new Error('network down'); };
  const plan = { doClip: true, clipUrl: 'https://example.com/b', mentionAfterClip: false, newChat: false, focus: 'none', openAttach: false, openInbox: false };
  await applyPlan(plan);
  assert.equal(input.value, 'https://example.com/b');
  assert.equal(input.focused, true);
  // A raw thrown Error (never reached apiJson's !res.ok branch) carries no
  // .body, so clipErrorMessage falls back to its generic copy.
  assert.deepEqual(toastMessages, ['Could not clip that page. Try again.']);
});

test('applyPlan: failed clip WITH mention=1 still forces the fresh-chat fallback (unchanged)', async () => {
  // newChat=true (as clipPlanFields sets at parse time) drives applyPlan's
  // pre-existing newChat branch too -- mock its targets (and runtime.actions
  // so its convSearch-merge poll resolves on the first check) so this test
  // isn't stuck in the real ~5s give-up timeout.
  const newBtn = _fakeInput('');
  const draft = _fakeInput('');
  globalThis.document = {
    querySelector: (sel) => (sel === '[data-act="newChat"]' ? newBtn : draft),
  };
  runtime.actions = { convSearch: () => {} };
  globalThis.fetch = async () => { throw new Error('network down'); };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const plan = { doClip: true, clipUrl: 'https://example.com/c', mentionAfterClip: true, newChat: true, focus: 'none', openAttach: false, openInbox: false };
    await applyPlan(plan);
    assert.equal(plan.focus, 'input');
    assert.equal(plan.prefill, 'https://example.com/c');
    assert.equal(draft.value, 'https://example.com/c'); // shared focus block actually applied it
  } finally {
    console.warn = origWarn;
    runtime.actions = undefined;
  }
});

test('applyPlan: successful clip (no mention) opens the document, unaffected by the failure-path fix', async () => {
  runtime.actions = { openDoc: (id) => { runtime.actions._openedId = id; } };
  globalThis.fetch = async () => _jsonRes({ ok: true, document: { id: 'doc-99' }, mention: '[[doc-99|a]]', meta: {} });
  try {
    const plan = { doClip: true, clipUrl: 'https://example.com/d', mentionAfterClip: false, newChat: false, focus: 'none', openAttach: false, openInbox: false };
    await applyPlan(plan);
    assert.equal(runtime.actions._openedId, 'doc-99');
  } finally {
    runtime.actions = undefined;
  }
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
