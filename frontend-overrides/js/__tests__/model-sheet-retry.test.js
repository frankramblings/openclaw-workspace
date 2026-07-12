import { test } from 'node:test';
import assert from 'node:assert';
import { modelLoadDecision, renderModelSheet } from '../redesign/mobile/mobile-sheets.js';

// modelLoadDecision is the pure core behind the mobile model sheet's
// tap-to-retry state. live/chat.js's loadModelOptions() swallows GET
// /api/models failures without setting any flag or re-rendering, so left to
// itself the sheet would show "Loading models…" forever. This decision
// function (mirrors live/jobs.js's fadeDecision) tracks a load-attempt
// window and, once it runs out, tells the caller to flip to a retryable
// state and to schedule exactly one re-render at the timeout boundary.

test('first render with no models yet starts the window and asks for one timer', () => {
  const d = modelLoadDecision({ attemptAt: 0, now: 1000, hasTimer: false, timeoutMs: 6000 });
  assert.equal(d.attemptAt, 1000);
  assert.equal(d.timedOut, false);
  assert.equal(d.scheduleMs, 6000);
});

test('a render mid-window with a timer already pending does not ask for a second one', () => {
  const d = modelLoadDecision({ attemptAt: 1000, now: 3000, hasTimer: true, timeoutMs: 6000 });
  assert.equal(d.attemptAt, 1000);
  assert.equal(d.timedOut, false);
  assert.equal(d.scheduleMs, null); // guard: never stack a second timer
});

test('once elapsed reaches the timeout, the sheet is marked timed out with no further timer', () => {
  const d = modelLoadDecision({ attemptAt: 1000, now: 7000, hasTimer: true, timeoutMs: 6000 });
  assert.equal(d.timedOut, true);
  assert.equal(d.scheduleMs, null);
});

test('boundary: elapsed exactly equal to timeoutMs times out (>=, not >)', () => {
  // attemptAt:0 is the module's own "unset" sentinel (fresh window starts at
  // `now`), so a real in-progress window needs a non-zero anchor here.
  const d = modelLoadDecision({ attemptAt: 1000, now: 7000, hasTimer: false, timeoutMs: 6000 });
  assert.equal(d.timedOut, true);
});

test('defaults timeoutMs to the module MODEL_LOAD_TIMEOUT_MS (6000ms) when omitted', () => {
  const notYet = modelLoadDecision({ attemptAt: 1000, now: 6999, hasTimer: false });
  assert.equal(notYet.timedOut, false);
  const atBoundary = modelLoadDecision({ attemptAt: 1000, now: 7000, hasTimer: false });
  assert.equal(atBoundary.timedOut, true);
});

// ---- renderModelSheet integration (string-level; no DOM/runtime needed) ---

test('renderModelSheet shows "Loading models…" before the timeout, no retry affordance', () => {
  const html = renderModelSheet({ live: {} });
  assert.match(html, /Loading models…/);
  assert.doesNotMatch(html, /tap to retry/);
});

test('renderModelSheet with a populated catalog renders the model list, not a loading/retry state', () => {
  const s = {
    live: {
      modelGroups: [{ ep: 'Claude CLI', endpointId: 'claude-cli', hasTag: false, tag: '', models: [
        { id: 'claude-cli·claude-opus-4-8', mid: 'claude-opus-4-8', name: 'Claude Opus 4.8', endpointId: 'claude-cli', ep: 'Claude CLI' },
      ] }],
      defaultModel: 'claude-cli·claude-opus-4-8',
      chat: { model: 'claude-opus-4-8', endpointId: 'claude-cli' },
    },
  };
  const html = renderModelSheet(s);
  assert.match(html, /Claude Opus 4\.8/);
  assert.doesNotMatch(html, /Loading models…/);
  assert.doesNotMatch(html, /tap to retry/);
});
