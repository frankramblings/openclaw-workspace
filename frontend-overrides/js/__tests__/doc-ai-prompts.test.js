import { test } from 'node:test';
import assert from 'node:assert';
import {
  ASK_PLACEHOLDER, buildSummarizePrompt, buildContinuePrompt, buildRewritePrompt, lineRangeFor,
} from '../redesign/doc-ai-prompts.js';

test('buildSummarizePrompt is read-only and asks for bullets + open questions', () => {
  const p = buildSummarizePrompt();
  assert.match(p, /5 to 8 bullets/);
  assert.match(p, /open questions/);
  assert.match(p, /Do not edit the file/);
});

test('buildContinuePrompt asks to append in the same voice', () => {
  const p = buildContinuePrompt();
  assert.match(p, /Continue writing from the end/);
  assert.match(p, /append to the file/);
});

test('lineRangeFor counts 1-based lines from character offsets, tolerating a reversed or null range', () => {
  const md = 'line one\nline two\nline three\n';
  assert.deepStrictEqual(lineRangeFor(md, 0, 4), { start: 1, end: 1 });
  assert.deepStrictEqual(lineRangeFor(md, 0, 12), { start: 1, end: 2 });
  assert.deepStrictEqual(lineRangeFor(md, 9, 27), { start: 2, end: 3 });
  assert.deepStrictEqual(lineRangeFor('a\nb\nc\n', 4, 2), { start: 2, end: 3 }); // reversed
  assert.deepStrictEqual(lineRangeFor('a\nb\nc\n', null, null), { start: 1, end: 1 });
});

test('buildRewritePrompt returns null with no selection (caller asks the user to select)', () => {
  assert.equal(buildRewritePrompt(null, 'body'), null);
  assert.equal(buildRewritePrompt({ text: '' }, 'body'), null);
  assert.equal(buildRewritePrompt({ text: '   ' }, 'body'), null);
});

test('buildRewritePrompt quotes the passage and names its line range', () => {
  const md = 'line one\nline two\nline three\n';
  const p = buildRewritePrompt({ text: 'line two', from: 9, to: 17 }, md);
  assert.match(p, /lines 2\.\.2/);
  assert.match(p, /── selection ──\nline two\n── end selection ──/);
  assert.match(p, /edit the file in place/);
});

test('buildRewritePrompt without a character range still quotes the text (wysiwyg mode)', () => {
  const p = buildRewritePrompt({ text: 'some prose', from: null, to: null }, 'irrelevant');
  assert.match(p, /the selected passage \(quoted below\)/);
  assert.match(p, /some prose/);
});

test('ASK_PLACEHOLDER is composer hint text, not a prompt, and no em dashes anywhere', () => {
  assert.equal(ASK_PLACEHOLDER, 'Ask about this document');
  const all = [buildSummarizePrompt(), buildContinuePrompt(),
    buildRewritePrompt({ text: 'x', from: 0, to: 1 }, 'x'), ASK_PLACEHOLDER].join('\n');
  assert.ok(!all.includes('—')); // em dash
});
