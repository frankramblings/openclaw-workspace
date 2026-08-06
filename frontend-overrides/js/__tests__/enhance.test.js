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

const { renderMath, enhanceChatEl, __resetKatexPromise } = await import('../redesign/enhance.js');

test('renderMath calls katex.renderToString on each un-done math node and marks it done', async () => {
  __resetKatexPromise();
  installDomStubs();
  const calls = [];
  globalThis.window.katex = { renderToString: (tex, opts) => { calls.push([tex, opts]); return `<span class="katex">${tex}</span>`; } };
  const el = { classList: fakeClassList(), getAttribute: () => 'x^2', innerHTML: '' };
  const container = { querySelectorAll: (sel) => (sel.includes('data-math') ? [el] : []) };

  await renderMath(container);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'x^2');
  assert.strictEqual(calls[0][1].throwOnError, false);
  assert.ok(el.classList.contains('math-done'));
  assert.match(el.innerHTML, /katex/);
});

test('renderMath uses displayMode:true for math-block and false for math-inline', async () => {
  __resetKatexPromise();
  installDomStubs();
  const seen = [];
  globalThis.window.katex = { renderToString: (tex, opts) => { seen.push(opts.displayMode); return 'x'; } };
  const blockEl = { classList: fakeClassList(), getAttribute: () => 'a', innerHTML: '' };
  blockEl.classList.contains = (c) => c === 'math-block';
  const inlineEl = { classList: fakeClassList(), getAttribute: () => 'b', innerHTML: '' };
  const container = { querySelectorAll: () => [blockEl, inlineEl] };

  await renderMath(container);

  assert.deepStrictEqual(seen, [true, false]);
});

test('renderMath swallows a per-element katex error and still marks it done', async () => {
  __resetKatexPromise();
  installDomStubs();
  globalThis.window.katex = { renderToString: () => { throw new Error('bad latex'); } };
  const el = { classList: fakeClassList(), getAttribute: () => 'x', innerHTML: '' };
  const container = { querySelectorAll: () => [el] };

  await renderMath(container);

  assert.ok(el.classList.contains('math-done'));
});

test('enhanceChatEl runs both highlighting and math rendering', async () => {
  __resetHljsPromise();
  __resetKatexPromise();
  installDomStubs();
  const hlCalls = [];
  const mathCalls = [];
  globalThis.window.hljs = { highlightElement: (el) => hlCalls.push(el) };
  globalThis.window.katex = { renderToString: (tex) => { mathCalls.push(tex); return 'x'; } };
  const codeEl = { classList: fakeClassList() };
  const mathEl = { classList: fakeClassList(), getAttribute: () => 'y', innerHTML: '' };
  const container = {
    querySelectorAll: (sel) => (sel.includes('code') ? [codeEl] : sel.includes('data-math') ? [mathEl] : []),
  };

  await enhanceChatEl(container);

  assert.strictEqual(hlCalls.length, 1);
  assert.strictEqual(mathCalls.length, 1);
});

test('renderMath does not call katex.renderToString twice when invoked concurrently without await', async () => {
  __resetKatexPromise();
  installDomStubs();
  const calls = [];
  globalThis.window.katex = { renderToString: (tex, opts) => { calls.push(tex); return `<span class="katex">${tex}</span>`; } };
  const mathEl = { classList: fakeClassList(), getAttribute: () => 'x^2', innerHTML: '' };
  const container = { querySelectorAll: (sel) => (sel.includes('data-math') ? [mathEl] : []) };

  // Call renderMath twice without awaiting the first before starting the second
  const p1 = renderMath(container);
  const p2 = renderMath(container);
  await Promise.all([p1, p2]);

  // Should have called katex.renderToString exactly once, not twice
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0], 'x^2');
  assert.ok(mathEl.classList.contains('math-done'));
});
