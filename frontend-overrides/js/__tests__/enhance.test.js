import { test } from 'node:test';
import assert from 'node:assert';

function fakeClassList() {
  const set = new Set();
  return { add: (c) => set.add(c), contains: (c) => set.has(c) };
}

function installDomStubs() {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }),
    head: { appendChild() {} },
  };
  globalThis.window = {};
}

installDomStubs();
const { highlightCode } = await import('../redesign/enhance.js');

test('highlightCode calls hljs.highlightElement on each un-done code block and marks it done', async () => {
  installDomStubs();
  const calls = [];
  globalThis.window.hljs = { highlightElement: (el) => calls.push(el) };
  const codeEl = { classList: fakeClassList() };
  const container = { querySelectorAll: (sel) => (sel.includes('code') ? [codeEl] : []) };

  await highlightCode(container);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0], codeEl);
  assert.ok(codeEl.classList.contains('hljs-done'));
});

test('highlightCode is a no-op when there is nothing to highlight', async () => {
  installDomStubs();
  const calls = [];
  globalThis.window.hljs = { highlightElement: (el) => calls.push(el) };
  const container = { querySelectorAll: () => [] };

  await highlightCode(container);

  assert.strictEqual(calls.length, 0);
});

test('highlightCode swallows a per-element hljs error and still marks it done (no crash, no infinite retry)', async () => {
  installDomStubs();
  globalThis.window.hljs = { highlightElement: () => { throw new Error('boom'); } };
  const codeEl = { classList: fakeClassList() };
  const container = { querySelectorAll: () => [codeEl] };

  await highlightCode(container);

  assert.ok(codeEl.classList.contains('hljs-done'));
});

test('highlightCode handles a null container without throwing', async () => {
  installDomStubs();
  await assert.doesNotReject(() => highlightCode(null));
});
