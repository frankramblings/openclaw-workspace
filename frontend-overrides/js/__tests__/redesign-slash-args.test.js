import { test } from 'node:test';
import assert from 'node:assert';
import { filterSlashCommands } from '../redesign/data.js';

// Task 4.3: once the draft is an exact slash-command token followed by typed
// arguments ("/run ls"), the autocomplete menu must close (no matches) so
// Enter falls through to send() instead of pickSlash() resetting the draft
// back to "/run " and destroying the typed args (see app.js keydown wiring).

test('bare "/" matches every command (menu opens with the full list)', () => {
  const filtered = filterSlashCommands('/');
  assert.equal(filtered.length, 6);
});

test('a command prefix with no space still narrows by prefix (unchanged pick behavior)', () => {
  const filtered = filterSlashCommands('/ru');
  assert.deepEqual(filtered.map((c) => c.name), ['/run']);
});

test('an exact command with no trailing space still matches (pickable)', () => {
  const filtered = filterSlashCommands('/run');
  assert.deepEqual(filtered.map((c) => c.name), ['/run']);
});

test('an exact command plus a trailing space with no args yet still matches', () => {
  const filtered = filterSlashCommands('/run ');
  assert.deepEqual(filtered.map((c) => c.name), ['/run']);
});

test('an exact command followed by typed arguments closes the menu (no matches)', () => {
  assert.deepEqual(filterSlashCommands('/run ls'), []);
});

test('menu stays closed as more argument text is typed', () => {
  assert.deepEqual(filterSlashCommands('/run ls -la'), []);
});

test('a single-letter argument is enough to close the menu', () => {
  assert.deepEqual(filterSlashCommands('/run l'), []);
});

test('a non-command prefix with args still filters by prefix (not an exact match, so unaffected)', () => {
  // "ru" is not itself a full command name — the existing prefix-match
  // behavior is preserved rather than treated as "args after an exact match".
  const filtered = filterSlashCommands('/ru ls');
  assert.deepEqual(filtered.map((c) => c.name), ['/run']);
});

test('args typing is case-insensitive against the command name', () => {
  assert.deepEqual(filterSlashCommands('/RUN ls'), []);
});

test('an unknown command with args still yields no matches (was already true, stays true)', () => {
  assert.deepEqual(filterSlashCommands('/bogus xyz'), []);
});

test('plain text (no leading slash) still matches everything, ignoring spaces', () => {
  const filtered = filterSlashCommands('hello there');
  assert.equal(filtered.length, 6);
});

test('empty/undefined draft matches everything', () => {
  assert.equal(filterSlashCommands('').length, 6);
  assert.equal(filterSlashCommands(undefined).length, 6);
});

test('/nano is exposed as a Nano Banana shortcut', () => {
  const filtered = filterSlashCommands('/na');
  assert.deepEqual(filtered.map((c) => c.name), ['/nano']);
});

test('/pplx is exposed as a Perplexity sidecar shortcut', () => {
  const filtered = filterSlashCommands('/pp');
  assert.deepEqual(filtered.map((c) => c.name), ['/pplx']);
});
