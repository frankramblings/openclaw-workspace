# UNIT-101 — pipeline markup: fences, math sentinels, mermaid cards

## Objective
Extend `src/lib/markdown.ts` (pure, sync, escape-first) to emit the contract's
code-card / math / mermaid markup. Tests.

## Inputs / context
- CONTRACT.md markup shapes (binding, byte-level).
- Read all of `src/lib/markdown.ts` first — reuse its sentinel mechanism
  (C0/C1 pattern near the top) and its fence handling; do not restructure
  working parts. `src/lib/markdown.test.ts` shows the test idiom.

## Approach
- Fences: current fence rendering becomes the code-card form. lang from the
  fence info string (first token, lowercased, `[a-z0-9+#-]` only, else empty).
  data-lines = raw line count. Unclosed fence at end of input → data-open="1",
  never collapsed. lang `mermaid` → mermaid-card form instead.
- Math: extract `$$…$$`, `\[…\]`, `\(…\)` spans pre-escape via new sentinels
  (same pattern as code spans; code spans/fences take precedence — math is NOT
  recognized inside them). data-math attribute value must be attribute-escaped;
  visible fallback content is the escaped latex.
- Keep everything synchronous and dep-free.
- Tests: fence with/without lang; >30-line collapse markup; ≤30 no collapse;
  unclosed streaming fence (data-open, no collapse); mermaid card; each math
  delimiter; `$…$` NOT treated as math; math inside code span/fence ignored;
  attribute-escaping of quotes/angle brackets in data-math and data-lang;
  copy button + expand button markup exact.

## Constraints
- Existing markdown tests must all still pass unchanged EXCEPT tests that
  assert the old fence markup — update those to the new shape, preserving
  their original intent (say which in the report).

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; test count increased (report before/after)
- [ ] (assertional) emitted markup byte-matches the contract shapes; pipeline still sync + dep-free; escape-first property holds for all new paths

## Dependencies
none
