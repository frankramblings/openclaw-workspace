import { test, expect } from 'vitest'
import { enhanceMessageEl } from './enhance'

test('enhanceMessageEl accepts streaming flag', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<div class="code-card md-fence" data-lang="js"><pre><code class="language-js">x</code></pre></div>'

  // Should not throw
  await expect(enhanceMessageEl(el, { streaming: true })).resolves.not.toThrow()
  await expect(enhanceMessageEl(el, { streaming: false })).resolves.not.toThrow()
})

test('enhanceMessageEl is idempotent during streaming', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<div class="code-card md-fence"><pre><code class="language-js">x</code></pre></div>'

  // Call twice with streaming - should not error
  await enhanceMessageEl(el, { streaming: true })
  await enhanceMessageEl(el, { streaming: true })
  expect(el.querySelector('code')).not.toBeNull()
})

test('enhanceMessageEl handles elements with data-open="1" (streaming fence)', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<div class="code-card md-fence" data-open="1"><pre><code class="language-js">x</code></pre></div>'

  // Should handle open fences gracefully
  await expect(enhanceMessageEl(el, { streaming: true })).resolves.not.toThrow()
})

test('enhanceMessageEl handles math elements', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<span class="math-inline" data-math="E=mc^2">E=mc^2</span>'

  // Should handle math gracefully (actual rendering requires katex)
  await expect(enhanceMessageEl(el, { streaming: false })).resolves.not.toThrow()
})

test('enhanceMessageEl handles mermaid elements', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<div class="mermaid-card" data-mermaid="graph TD"><pre>graph TD</pre></div>'

  // Should handle mermaid gracefully (actual rendering requires mermaid)
  await expect(enhanceMessageEl(el, { streaming: false })).resolves.not.toThrow()
})

test('enhanceMessageEl does not render mermaid when streaming', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<div class="mermaid-card" data-mermaid="graph TD"><pre>graph TD</pre></div>'

  await enhanceMessageEl(el, { streaming: true })

  // Mermaid source should still be visible (not replaced by SVG during streaming)
  expect(el.querySelector('.mermaid-card pre')).not.toBeNull()
})

test('enhanceMessageEl handles empty elements', async () => {
  const el = document.createElement('div')

  // Should not throw on empty element
  await expect(enhanceMessageEl(el, { streaming: false })).resolves.not.toThrow()
})

// --- Adversarial / property probes (thrifty-check UNIT-102 pass) -----------

test('idempotence: calling enhanceMessageEl twice on already-rendered math does not re-invoke KaTeX or corrupt the output', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<span class="math-inline" data-math="E=mc^2">E=mc^2</span>'

  await enhanceMessageEl(el, { streaming: false })
  const afterFirst = el.querySelector('.math-inline')!.innerHTML
  expect(afterFirst).not.toBe('E=mc^2') // katex actually rendered something
  expect(el.querySelector('.math-inline')!.classList.contains('math-done')).toBe(true)

  await enhanceMessageEl(el, { streaming: false })
  const afterSecond = el.querySelector('.math-inline')!.innerHTML

  // Second pass must be a byte-identical no-op, not a re-render (which would
  // either double-wrap katex's own <span class="katex">... output or at
  // least do redundant work against a .math-done element).
  expect(afterSecond).toBe(afterFirst)
})

test('idempotence: calling enhanceMessageEl twice on already-rendered mermaid does not re-invoke mermaid.render', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<div class="mermaid-card" data-mermaid="graph TD; A-->B"><pre>graph TD; A--&gt;B</pre></div>'

  await enhanceMessageEl(el, { streaming: false })
  const afterFirst = el.querySelector('.mermaid-card')!.innerHTML

  await enhanceMessageEl(el, { streaming: false })
  const afterSecond = el.querySelector('.mermaid-card')!.innerHTML

  expect(afterSecond).toBe(afterFirst)
})

test('debounce cannot drop the final pass: a completion call right after a streaming call still fully enhances', async () => {
  const el = document.createElement('div')
  el.innerHTML = '<div class="code-card md-fence"><pre><code class="language-js">const x = 1;</code></pre></div>'
    + '<span class="math-inline" data-math="x+1">x+1</span>'

  // Kick off a streaming pass (debounced ~300ms) then, before it can fire,
  // the turn completes — the completion pass must not wait on the debounce
  // timer and must fully enhance (including math, which streaming skips).
  void enhanceMessageEl(el, { streaming: true })
  await enhanceMessageEl(el, { streaming: false })

  expect(el.querySelector('code')!.classList.contains('hljs-done') || el.querySelector('code')!.classList.contains('hljs')).toBe(true)
  expect(el.querySelector('.math-inline')!.classList.contains('math-done')).toBe(true)
})
