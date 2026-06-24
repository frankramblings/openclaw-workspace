import { test } from 'node:test';
import assert from 'node:assert';
import { I } from '../redesign/icons.js';

test('copy and download icons return svg strings', () => {
  assert.match(I.copy(), /<svg[\s\S]*<\/svg>/);
  assert.match(I.download(), /<svg[\s\S]*<\/svg>/);
});

test('dots icon returns an svg', () => {
  assert.match(I.dots(), /<svg[\s\S]*<\/svg>/);
});

test('star is hollow by default and filled when requested', () => {
  assert.match(I.star(13, false), /fill="none"/);
  assert.match(I.star(13, true), /fill="currentColor"/);
});

test('menu glyphs (pencil, archive, trash) return svg strings', () => {
  assert.match(I.pencil(), /<svg[\s\S]*<\/svg>/);
  assert.match(I.archive(), /<svg[\s\S]*<\/svg>/);
  assert.match(I.trash(), /<svg[\s\S]*<\/svg>/);
});
