# UNIT-102 — lazy enhancers (hljs/katex/mermaid) + Message effect

## Objective
`src/lib/enhance.ts` per the contract's Enhancer API; wire into Message.tsx;
add the three deps as lazy chunks only.

## Inputs / context
- CONTRACT.md Enhancer API (binding).
- `src/tabs/chat/Message.tsx` — the msg-markdown div (dangerouslySetInnerHTML).
- Streaming flag: find how the chat store marks the in-flight assistant
  message (`src/tabs/chat/store.ts` / `PendingMessage.tsx` / `reducer.ts`) and
  thread it to Message as a prop (smallest honest wiring; report what you
  found).
- `npm install highlight.js katex mermaid` (caret versions, package.json).

## Approach
- enhance.ts: module-level singleton promises for each lazy import (fetch
  once). Highlight: `el.querySelectorAll('.code-card:not([data-open]) pre
  code:not(.hljs-done)')` → `hljs.highlightElement`, mark done. Debounce
  streaming passes ≥300 ms per element tree. katex: render into
  `.math-inline/.math-block` from data-math (`throwOnError: false`); mermaid:
  `.mermaid-card` → `mermaid.render` to SVG, failure → add `mermaid-failed`,
  keep pre. Import 'katex/dist/katex.min.css' and an hljs dark-suitable theme
  css INSIDE the lazy chunk. Idempotent: re-running on an enhanced element is
  a no-op (guard classes).
- Message.tsx: `useEffect` on [html, streaming] → `enhanceMessageEl(node,
  {streaming})`. dangerouslySetInnerHTML replaces DOM each render — the
  effect re-runs after; that is the re-enhance path, rely on it.
- Tests: enhance.ts with mocked dynamic imports (vi.mock the three packages):
  streaming skips mermaid + open fences; completion renders all; idempotence;
  mermaid failure path adds class and keeps source.

## Constraints
- The three packages must appear in NO static import anywhere (grep to
  confirm) — dynamic `import()` inside enhance.ts only.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; test count increased (report before/after)
- [ ] (runnable) `ls dist/assets | grep -iE "katex|mermaid|highlight|hljs"` shows separate chunks; main `index-*.js` gzip ≤ 116 KB (report the number from vite output)
- [ ] (assertional) enhance API matches contract exactly; no static imports of the three deps; fonts/css emitted via the lazy chunks

## Dependencies
UNIT-101
