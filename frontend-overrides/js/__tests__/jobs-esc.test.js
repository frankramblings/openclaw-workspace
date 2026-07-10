import { test } from 'node:test';
import assert from 'node:assert';
import { esc } from '../redesign/live/jobs.js';

test('jobs esc escapes quotes so labels cannot break out of title attributes', () => {
  assert.equal(esc('a "b" c'), 'a &quot;b&quot; c');
  assert.equal(esc("it's"), 'it&#39;s');
  assert.equal(esc('<x> & "y"'), '&lt;x&gt; &amp; &quot;y&quot;');
});
