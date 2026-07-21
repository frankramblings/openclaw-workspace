// Lazy enhancers for code highlighting, math rendering, and diagram rendering.
// All three libraries are imported dynamically inside this module to keep them
// out of the main bundle until needed.

// Module-level promises to ensure we only fetch each library once
let hlPromise: Promise<{ default: { highlightElement: (el: HTMLElement) => void } }> | null = null
let katexPromise: Promise<{ default: { renderToString: (latex: string, opts?: unknown) => string } }> | null = null
let mermaidPromise: Promise<{ default: { render: (id: string, source: string) => Promise<{ svg: string }> } }> | null = null

function getHljs() {
  if (!hlPromise) {
    // lib/common = ~37 common languages (~50 KB gzip) vs the full build's ~190
    // languages (~312 KB gzip) — chat code blocks never need cobol.
    hlPromise = import('highlight.js/lib/common') as Promise<{ default: { highlightElement: (el: HTMLElement) => void } }>
  }
  return hlPromise
}

function getKatex() {
  if (!katexPromise) {
    katexPromise = import('katex') as Promise<{ default: { renderToString: (latex: string, opts?: unknown) => string } }>
  }
  return katexPromise
}

function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid') as Promise<{ default: { render: (id: string, source: string) => Promise<{ svg: string }> } }>
  }
  return mermaidPromise
}

/** Debounce highlight calls during streaming to avoid excessive work */
const highlightDebounces = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

function debounceHighlight(el: HTMLElement, callback: () => void, delay: number = 300) {
  const existing = highlightDebounces.get(el)
  if (existing) clearTimeout(existing)
  const timeout = setTimeout(() => {
    callback()
    highlightDebounces.delete(el)
  }, delay)
  highlightDebounces.set(el, timeout)
}

/**
 * Enhance a message element with highlighting, math rendering, and diagram rendering.
 * Idempotent: can be called multiple times on the same element.
 * @param el The element containing the rendered markdown
 * @param opts.streaming Whether the message is still streaming (affects what gets enhanced)
 */
export async function enhanceMessageEl(el: HTMLElement, opts: { streaming: boolean }): Promise<void> {
  // Highlight closed code fences (not open/streaming ones)
  if (opts.streaming) {
    // During streaming, only highlight closed fences with debouncing
    debounceHighlight(el, () => {
      highlightClosedFences(el)
    }, 300)
  } else {
    // On completion, do a full pass
    await highlightClosedFences(el)
    await renderMath(el)
    await renderMermaid(el)
  }
}

async function highlightClosedFences(el: HTMLElement): Promise<void> {
  try {
    const hlModule = await getHljs()
    const hljs = hlModule.default
    // Select closed fences only (not data-open="1") and highlight unhighlighted code elements
    const codeElements = el.querySelectorAll('.code-card:not([data-open]) pre code:not(.hljs-done)')
    for (const code of codeElements) {
      hljs.highlightElement(code as HTMLElement)
      // Mark as done to avoid re-highlighting on subsequent calls
      code.classList.add('hljs-done')
    }
  } catch (err) {
    console.error('Failed to highlight code:', err)
  }
}

async function renderMath(el: HTMLElement): Promise<void> {
  try {
    const katexModule = await getKatex()
    const katex = katexModule.default

    // Render inline math
    const inlineElements = el.querySelectorAll('.math-inline[data-math]:not(.math-done)')
    for (const elem of inlineElements) {
      const latex = elem.getAttribute('data-math')
      if (latex) {
        try {
          const html = katex.renderToString(latex, { throwOnError: false })
          elem.innerHTML = html
          elem.classList.add('math-done')
        } catch (err) {
          console.warn('KaTeX render failed:', err)
        }
      }
    }

    // Render block math
    const blockElements = el.querySelectorAll('.math-block[data-math]:not(.math-done)')
    for (const elem of blockElements) {
      const latex = elem.getAttribute('data-math')
      if (latex) {
        try {
          const html = katex.renderToString(latex, { throwOnError: false, displayMode: true })
          elem.innerHTML = html
          elem.classList.add('math-done')
        } catch (err) {
          console.warn('KaTeX render failed:', err)
        }
      }
    }
  } catch (err) {
    console.error('Failed to load KaTeX:', err)
  }
}

async function renderMermaid(el: HTMLElement): Promise<void> {
  try {
    const mermaidModule = await getMermaid()
    const mermaid = mermaidModule.default

    const mermaidElements = el.querySelectorAll('.mermaid-card:not(.mermaid-done)')
    for (const elem of mermaidElements) {
      const source = elem.getAttribute('data-mermaid')
      if (source) {
        try {
          const { svg } = await mermaid.render(`mermaid-${Date.now()}-${Math.random()}`, source)
          elem.innerHTML = svg
          elem.classList.add('mermaid-done')
        } catch (err) {
          console.warn('Mermaid render failed:', err)
          // On failure, add class and keep the source visible (honesty rule)
          elem.classList.add('mermaid-failed')
        }
      }
    }
  } catch (err) {
    console.error('Failed to load mermaid:', err)
  }
}
