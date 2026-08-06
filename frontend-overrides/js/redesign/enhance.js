// Idempotent post-render enhancement: syntax highlighting (hljs) and math
// rendering (KaTeX) for chat messages. Both libraries are vendored (no CDN,
// no bundler — see js/vendor/hljs and js/vendor/katex) and lazy-loaded on
// first use via the same injectCss/injectScript pattern already used by
// workspace-terminal.js (xterm) and live/document-editor.js (Toast UI).
//
// Idempotency matters here specifically because classic's render() rebuilds
// message HTML via innerHTML on every full re-render — any DOM mutation this
// module makes (colored spans, rendered math) would be wiped by the next
// unrelated re-render if this only ran once. Marker classes (hljs-done,
// math-done) make repeated calls a cheap no-op scan over already-enhanced
// content, so callers can call enhanceChatEl() after every render without
// worrying about re-doing work.
const HLJS_VENDOR = '/static/js/vendor/hljs/';

let hljsPromise = null;

// Test-only: reset the cached hljs promise for test isolation
export function __resetHljsPromise() {
  hljsPromise = null;
}

function injectCss(href) {
  if (document.querySelector(`link[data-enhance-css="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  l.setAttribute('data-enhance-css', href);
  document.head.appendChild(l);
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureHljs() {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      injectCss(HLJS_VENDOR + 'hljs-theme.css');
      if (!window.hljs) await injectScript(HLJS_VENDOR + 'hljs.min.js');
      if (!window.hljs) throw new Error('highlight.js failed to load');
      return window.hljs;
    })();
  }
  return hljsPromise;
}

export async function highlightCode(container) {
  if (!container) return;
  const blocks = container.querySelectorAll('pre.md-code code:not(.hljs-done)');
  if (!blocks.length) return;
  let hljs;
  try {
    hljs = await ensureHljs();
  } catch (err) {
    console.error('[enhance] highlight.js failed to load', err);
    return;
  }
  for (const code of blocks) {
    if (code.classList.contains('hljs-done')) continue;
    try {
      hljs.highlightElement(code);
    } catch (err) {
      console.error('[enhance] highlight failed for one code block', err);
    }
    code.classList.add('hljs-done');
  }
}
