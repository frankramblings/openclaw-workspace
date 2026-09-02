import { test } from 'node:test';
import assert from 'node:assert';
import { parseHash, chatHash, SURFACES } from '../redesign/routes.js';

test('plain surface hashes parse to a surface with no session', () => {
  assert.deepEqual(parseHash('#calendar'), { surface: 'calendar', sessionId: null, special: null });
  assert.deepEqual(parseHash('#chat'), { surface: 'chat', sessionId: null, special: null });
});

test('#chat/<id> parses the session id', () => {
  assert.deepEqual(parseHash('#chat/ab12cd34ef56'), { surface: 'chat', sessionId: 'ab12cd34ef56', special: null });
});

test('a malformed session id is dropped, surface kept', () => {
  assert.deepEqual(parseHash('#chat/<script>'), { surface: 'chat', sessionId: null, special: null });
  assert.deepEqual(parseHash('#chat/'), { surface: 'chat', sessionId: null, special: null });
});

test('mobile specials and unknown hashes', () => {
  assert.deepEqual(parseHash('#more'), { surface: null, sessionId: null, special: 'more' });
  assert.deepEqual(parseHash('#capture'), { surface: null, sessionId: null, special: 'capture' });
  assert.deepEqual(parseHash('#nope'), { surface: null, sessionId: null, special: null });
  assert.deepEqual(parseHash(''), { surface: null, sessionId: null, special: null });
  assert.deepEqual(parseHash(undefined), { surface: null, sessionId: null, special: null });
});

test('chatHash formats both forms', () => {
  assert.equal(chatHash('ab12'), '#chat/ab12');
  assert.equal(chatHash(null), '#chat');
  assert.equal(chatHash(''), '#chat');
});

test('SURFACES matches the shell list', () => {
  assert.deepEqual(SURFACES, ['chat', 'inbox', 'email', 'calendar', 'research', 'library', 'notes', 'settings']);
});
