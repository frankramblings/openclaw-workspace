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
const { highlightCode, __resetHljsPromise } = await import('../redesign/enhance.js');

test('highlightCode calls hljs.highlightElement on each un-done code block and marks it done', async () => {
  __resetHljsPromise();
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
  __resetHljsPromise();
  installDomStubs();
  const calls = [];
  globalThis.window.hljs = { highlightElement: (el) => calls.push(el) };
  const container = { querySelectorAll: () => [] };

  await highlightCode(container);

  assert.strictEqual(calls.length, 0);
});

test('highlightCode swallows a per-element hljs error and still marks it done (no crash, no infinite retry)', async () => {
  __resetHljsPromise();
  installDomStubs();
  globalThis.window.hljs = { highlightElement: () => { throw new Error('boom'); } };
  const codeEl = { classList: fakeClassList() };
  const container = { querySelectorAll: () => [codeEl] };

  await highlightCode(container);

  assert.ok(codeEl.classList.contains('hljs-done'));
});

test('highlightCode handles a null container without throwing', async () => {
  __resetHljsPromise();
  installDomStubs();
  await assert.doesNotReject(() => highlightCode(null));
});

test('highlightCode does not call hljs.highlightElement twice when invoked concurrently without await', async () => {
  __resetHljsPromise();
  installDomStubs();
  const calls = [];
  globalThis.window.hljs = { highlightElement: (el) => calls.push(el) };
  const codeEl = { classList: fakeClassList() };
  const container = { querySelectorAll: (sel) => (sel.includes('code') ? [codeEl] : []) };

  // Call highlightCode twice without awaiting the first before starting the second
  const p1 = highlightCode(container);
  const p2 = highlightCode(container);
  await Promise.all([p1, p2]);

  // Should have called hljs.highlightElement exactly once, not twice
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0], codeEl);
  assert.ok(codeEl.classList.contains('hljs-done'));
});
