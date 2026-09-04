// Pure-function tests for the @-mention composer helpers: caret-aware
// token detection, insertion text, close rules, and picker markup. No DOM
// globals needed -- mention-core.js touches no `document`/`window` at all
// (mention-picker.js, tested separately by inspection per this project's
// stated preference for testing pure decision-helpers, owns the DOM side).
import { test } from 'node:test';
import assert from 'node:assert';

const { mentionTokenAtCaret, shouldClose, insertMention, renderPickerHtml } =
  await import('../redesign/mention-core.js');

// ---- mentionTokenAtCaret ---------------------------------------------------

test('mentionTokenAtCaret: "@" at the very start of the draft opens a token', () => {
  assert.deepStrictEqual(mentionTokenAtCaret('@gro', 4), { start: 0, query: 'gro' });
});

test('mentionTokenAtCaret: "@" right after whitespace opens a token', () => {
  assert.deepStrictEqual(mentionTokenAtCaret('see @doc', 8), { start: 4, query: 'doc' });
});

test('mentionTokenAtCaret: "@" glued to a preceding word never triggers (email addresses)', () => {
  assert.strictEqual(mentionTokenAtCaret('frank@example.com', 18), null);
  assert.strictEqual(mentionTokenAtCaret('email me at frank@ex', 21), null);
});

test('mentionTokenAtCaret: query is only the text between "@" and the caret, not the whole word', () => {
  // caret sits between "wor" and "ld" -- text after the caret is irrelevant.
  assert.deepStrictEqual(mentionTokenAtCaret('hello @world ', 10), { start: 6, query: 'wor' });
});

test('mentionTokenAtCaret: a second "@" closes the earlier one (only the latest @ can be open)', () => {
  assert.deepStrictEqual(mentionTokenAtCaret('@a @b', 5), { start: 3, query: 'b' });
});

test('mentionTokenAtCaret: no "@" before the caret at all', () => {
  assert.strictEqual(mentionTokenAtCaret('just some text', 14), null);
});

test('mentionTokenAtCaret: whitespace right before the caret closes the token', () => {
  assert.strictEqual(mentionTokenAtCaret('@abc ', 5), null);
});

test('mentionTokenAtCaret: tolerates non-string/non-number input', () => {
  assert.strictEqual(mentionTokenAtCaret(null, 0), null);
  assert.strictEqual(mentionTokenAtCaret('@abc', undefined), null);
});

test('mentionTokenAtCaret: every caret position inside an already-completed token is null (no garbage query), all the way through its trailing space', () => {
  // Built by insertMention itself so the fixture can't drift from the real
  // token shape: "@[Groceries](note:n1) ".
  const built = insertMention('@x', 0, 2, { kind: 'note', id: 'n1', title: 'Groceries' });
  const text = built.text;
  // caret === 1 is right after the bare "@", before the "[" -- with nothing
  // typed yet since the "@" this is indistinguishable from a fresh,
  // empty-query trigger (the same state a brand new "@" starts in), so it
  // legitimately stays open rather than closing.
  assert.deepStrictEqual(mentionTokenAtCaret(text, 1), { start: 0, query: '' });
  // From the first bracket character onward -- through "]", "(", the kind,
  // id, ")" and the trailing space -- every position must be null.
  for (let caret = 2; caret <= text.length; caret++) {
    assert.strictEqual(mentionTokenAtCaret(text, caret), null, `caret=${caret} in ${JSON.stringify(text)}`);
  }
});

test('mentionTokenAtCaret: a fresh "@query" typed right after a completed token still triggers', () => {
  const built = insertMention('@x', 0, 2, { kind: 'note', id: 'n1', title: 'Groceries' });
  const text = built.text + '@gro';
  assert.deepStrictEqual(mentionTokenAtCaret(text, text.length), { start: built.text.length, query: 'gro' });
});

// ---- shouldClose ------------------------------------------------------------

test('shouldClose: false while the caret stays inside the open token', () => {
  assert.strictEqual(shouldClose('@abc', 4, 0), false);
  assert.strictEqual(shouldClose('@abc', 1, 0), false);
});

test('shouldClose: true once the caret moves before the "@"', () => {
  assert.strictEqual(shouldClose('@abc', 0, 0), true);
});

test('shouldClose: true once whitespace appears between "@" and the caret', () => {
  assert.strictEqual(shouldClose('@ab c', 5, 0), true);
});

test('shouldClose: true once a second "@" appears between "@" and the caret', () => {
  assert.strictEqual(shouldClose('@a@b', 4, 0), true);
});

test('shouldClose: true when the character at tokenStart is no longer "@" (text edited around it)', () => {
  assert.strictEqual(shouldClose('Xabc', 4, 0), true);
});

// ---- insertMention ------------------------------------------------------------

test('insertMention: builds a note token; no trailing space added when the text after the caret already starts with whitespace (no double space)', () => {
  const out = insertMention('hi @gro there', 3, 7, { kind: 'note', id: 'n1', title: 'Groceries' });
  assert.strictEqual(out.text, 'hi @[Groceries](note:n1) there');
  assert.strictEqual(out.caret, 'hi @[Groceries](note:n1)'.length);
});

test('insertMention: a palette "document" kind becomes a "doc" token, with a trailing space at the end of the draft', () => {
  const out = insertMention('@x', 0, 2, { kind: 'document', id: 'd1', title: 'Runbook' });
  assert.strictEqual(out.text, '@[Runbook](doc:d1) ');
  assert.strictEqual(out.caret, out.text.length);
});

test('insertMention: replaces exactly the [start, caret) range, keeping earlier and later text', () => {
  // start=7 is the "@"; caret=10 consumes "@qu" in full (indices 7-9), so
  // `after` is " after" (already starts with a space) -- single space out.
  const out = insertMention('before @qu after', 7, 10, { kind: 'note', id: 'n9', title: 'Q' });
  assert.strictEqual(out.text, 'before @[Q](note:n9) after');
});

test('insertMention: a title with "]", "(" and a newline is sanitized to match backend/mentions.py\'s MENTION_RE title grammar ([^\\]\\n]{1,200})', () => {
  // "]" and "\n" are removed outright (never replaced with a space); "("
  // and ")" are left alone -- the backend's title class only excludes "]"
  // and newline, so parentheses round-trip through the backend parser fine.
  const out = insertMention('@x', 0, 2, { kind: 'note', id: 'n1', title: 'Foo]Bar(Baz)\nQux' });
  assert.strictEqual(out.text, '@[FooBar(Baz)Qux](note:n1) ');
});

test('insertMention: runs of whitespace in the title collapse to a single space and the title is trimmed', () => {
  const out = insertMention('@x', 0, 2, { kind: 'note', id: 'n1', title: '  Foo   Bar\t\tBaz  ' });
  assert.strictEqual(out.text, '@[Foo Bar Baz](note:n1) ');
});

test('insertMention: a title longer than 200 characters is capped at 200, matching the backend grammar\'s {1,200} bound', () => {
  const out = insertMention('@x', 0, 2, { kind: 'note', id: 'n1', title: 'x'.repeat(250) });
  const captured = out.text.match(/^@\[([^\]]*)\]/)[1];
  assert.strictEqual(captured.length, 200);
});

test('insertMention: a title that sanitizes to nothing falls back to the id', () => {
  const out = insertMention('@x', 0, 2, { kind: 'note', id: 'n1', title: ']\n\r' });
  assert.strictEqual(out.text, '@[n1](note:n1) ');
});

test('insertMention: an id outside backend/mentions.py\'s id grammar ([A-Za-z0-9_-]{1,32}) inserts nothing, returning the input unchanged', () => {
  const out = insertMention('hi @gro there', 3, 7, { kind: 'note', id: 'bad id', title: 'X' });
  assert.deepStrictEqual(out, { text: 'hi @gro there', caret: 7 });
});

test('insertMention: an empty id inserts nothing, returning the input unchanged', () => {
  const out = insertMention('@x', 0, 2, { kind: 'note', id: '', title: 'X' });
  assert.deepStrictEqual(out, { text: '@x', caret: 2 });
});

test('insertMention: an id longer than 32 characters inserts nothing, returning the input unchanged', () => {
  const out = insertMention('@x', 0, 2, { kind: 'note', id: 'a'.repeat(33), title: 'X' });
  assert.deepStrictEqual(out, { text: '@x', caret: 2 });
});

// ---- renderPickerHtml -----------------------------------------------------------

test('renderPickerHtml: escapes titles and marks the highlighted row', () => {
  const html = renderPickerHtml(
    [{ kind: 'note', id: 'n1', title: '<script>x</script>' },
     { kind: 'document', id: 'd1', title: 'Runbook' }],
    1);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('mention-row sel'));
  assert.ok(html.includes('Document'));
});

test('renderPickerHtml: an empty item list renders a "no matches" state, not an empty menu', () => {
  const html = renderPickerHtml([], 0);
  assert.ok(html.includes('mention-menu'));
  assert.ok(/no matches/i.test(html));
});

test('renderPickerHtml: no em dashes anywhere in the rendered copy', () => {
  const html = renderPickerHtml(
    [{ kind: 'note', id: 'n1', title: 'Weekly notes' }], 0);
  assert.ok(!html.includes('—'));
});
