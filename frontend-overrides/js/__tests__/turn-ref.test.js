import { test } from 'node:test';
import assert from 'node:assert';
import { setLiveTurn, liveTurn } from '../redesign/live/turn-ref.js';

test('set, read, clear', () => {
  assert.equal(liveTurn(), null);
  setLiveTurn({ sessionId: 's1', turnId: 7, msgId: 'live-123' });
  assert.deepEqual(liveTurn(), { sessionId: 's1', turnId: 7, msgId: 'live-123' });
  setLiveTurn(null);
  assert.equal(liveTurn(), null);
});
