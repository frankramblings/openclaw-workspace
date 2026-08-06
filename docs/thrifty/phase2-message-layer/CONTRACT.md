# Phase 2 — Message layer — Contract

**Decomposition mode:** partition
**Planning tier:** direct

## Objective

Code-block affordances (highlight/copy/label/collapse), KaTeX math, mermaid
diagrams, and stick-to-bottom streaming scroll in `/next`. Four units:
pipeline markup → lazy enhancers → interactions+styles → scroll hook.
Spec: `docs/superpowers/specs/2026-07-20-phase2-message-layer-design.md`
(binding; read it first).

## Conventions

- `/next` only (`frontend-next/`). Honesty rule; escape-first pipeline purity:
  `src/lib/markdown.ts` stays synchronous and dependency-free.
- New deps allowed EXACTLY: `highlight.js`, `katex`, `mermaid` — imported ONLY
  via dynamic `import()` inside `src/lib/enhance.ts` (lazy Vite chunks; never
  in the main graph). Version style matches package.json (caret).
- Reuse existing CSS: `.code-card` + `.bar` + `.copy` (app.css:282-286) is the
  code-block chrome; extend in place, don't duplicate. All new styles into
  `src/styles/app.css` following its var() palette (light/dark aware).
- Tests colocated vitest per existing patterns. Known-failing baseline: 3
  (composer ×2, ModelPicker ×1) — never fix, never add to.
- No git commands. The repo has unrelated uncommitted WIP elsewhere.

## Interfaces (cross-unit)

**Pipeline markup** (owner UNIT-101; consumed by 102/103):
- Fenced block: `<div class="code-card md-fence" data-lang="<lang|>"
  data-lines="<n>"[ data-open="1"][ class+="collapsed"]><div class="bar">
  <span class="lang"><lang or 'text'></span><button class="copy"
  data-act="codeCopy">Copy</button></div><pre><code class="language-<lang>">
  <escaped></code></pre>[<button class="code-expand" data-act="codeExpand">
  Show all <n> lines</button>]</div>`
  - `data-open="1"` = fence not yet closed (streaming tail). `collapsed` class
    + expand button present iff `n > 30` AND fence closed.
- Math: `<span class="math-inline" data-math="<escaped latex>"><escaped
  latex></span>` · `<div class="math-block" data-math="…"><escaped></div>`
- Mermaid fence: `<div class="mermaid-card" data-mermaid="<escaped source>">
  <pre><escaped source></pre></div>` (replaces the code-card form for
  lang=mermaid).
- Sentinel mechanism: extend the existing C0/C1 code-span sentinel pattern —
  math/fences extracted pre-escape, restored post-transform.

**Enhancer API** (owner UNIT-102; consumed by Message.tsx):
- `src/lib/enhance.ts`: `export function enhanceMessageEl(el: HTMLElement,
  opts: { streaming: boolean }): void` — idempotent, fire-and-forget; lazy
  imports inside; on `streaming: true` highlight only closed fences
  (debounced ≥300 ms) and SKIP mermaid; on `streaming: false` full pass:
  highlight all, render math (katex → replaces placeholder content), render
  mermaid → SVG (failure: leave source `<pre>`, add class `mermaid-failed`).
- Theme: hljs theme CSS chosen to read on the app's existing code palette
  (dark bg #121317); imported inside the lazy chunk.

**Interactions** (owner UNIT-103): delegated `data-act` handlers `codeCopy`
(clipboard writeText of the fence's raw text + transient "Copied" label swap)
and `codeExpand` (removes `collapsed`, hides button). Register alongside the
existing `wsOpenFile` delegation in Message.tsx — ONE handler, extended.

**Scroll** (owner UNIT-104): `src/tabs/chat/useStickToBottom.ts` →
`{ pinned: boolean, jumpToBottom(): void }`; consumed only inside the chat
tab; pill markup/class `jump-bottom-pill`.

## Ownership map

- UNIT-101 → `src/lib/markdown.ts` + `src/lib/markdown.test.ts`
- UNIT-102 → `src/lib/enhance.ts` (new) + test, `package.json` deps,
  `src/tabs/chat/Message.tsx` (effect call + streaming prop)
- UNIT-103 → Message.tsx delegation, `src/styles/app.css`
- UNIT-104 → `useStickToBottom.ts` (new) + test, `Thread.tsx` (or the actual
  scroll container — discover), pill styles in app.css

## Dependency graph

```text
UNIT-101 → UNIT-102 → UNIT-103        UNIT-104 (independent)
```
Executor order: 101, 102, 103, 104.

## Gates

- Every unit: `cd frontend-next && npm run build && npm test` — no failures
  beyond the 3 known; test count must strictly INCREASE with each unit that
  adds tests (report before/after counts).
- UNIT-102 additionally: `ls dist/assets` shows hljs/katex/mermaid in
  separate lazy chunks; `dist/assets/index-*.js` gzip ≤ 116 KB (baseline
  105.98 + 10 allowance).

## Fix-loop overrides

Executor reports must list per-unit: files touched, gate outputs verbatim
(test counts), deviations. Claims are verified on disk by the orchestrator;
misreports route straight to redo.
