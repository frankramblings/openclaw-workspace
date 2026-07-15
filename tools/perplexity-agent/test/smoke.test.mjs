import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version } from '../src/index.mjs';

test('exports a package version marker', () => {
  assert.equal(version, '0.1.0');
});
