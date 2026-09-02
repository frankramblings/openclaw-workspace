import { test } from 'node:test';
import assert from 'node:assert';
import { busySendMode, steerFallback } from '../redesign/live/steer-logic.js';

const base = { busyHere: true, steerAvailable: true, endpointId: 'claude-cli', hasAttachments: false, forceQueue: false };

test('idle thread always sends', () => {
  assert.equal(busySendMode({ ...base, busyHere: false }), 'send');
});

test('busy + steer available + claude-cli + text only → steer', () => {
  assert.equal(busySendMode(base), 'steer');
});

test('busy but capability missing → queue', () => {
  assert.equal(busySendMode({ ...base, steerAvailable: false }), 'queue');
});

test('busy but not a claude-cli session → queue', () => {
  assert.equal(busySendMode({ ...base, endpointId: 'openai' }), 'queue');
  assert.equal(busySendMode({ ...base, endpointId: '' }), 'queue');
});

test('attachments never steer', () => {
  assert.equal(busySendMode({ ...base, hasAttachments: true }), 'queue');
});

test('explicit queue wins over steer', () => {
  assert.equal(busySendMode({ ...base, forceQueue: true }), 'queue');
});

test('fallback: no_active_turn → send normally', () => {
  assert.equal(steerFallback(409, { reason: 'no_active_turn' }), 'send');
});

test('fallback: steer_unavailable / gateway_error / network → queue', () => {
  assert.equal(steerFallback(409, { reason: 'steer_unavailable' }), 'queue');
  assert.equal(steerFallback(502, { reason: 'gateway_error' }), 'queue');
  assert.equal(steerFallback(0, null), 'queue');
});
