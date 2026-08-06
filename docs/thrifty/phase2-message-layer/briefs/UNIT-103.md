# UNIT-103 — copy/expand interactions + styles

## Objective
Working Copy and Show-all buttons; code-card/math/mermaid/pill styles that fit
the existing design language.

## Inputs / context
- CONTRACT.md Interactions section (binding).
- Message.tsx already has a delegated onClick for `data-act="wsOpenFile"` —
  EXTEND that one handler (switch on data-act), don't add parallel listeners.
- `src/styles/app.css` — `.code-card`/`.bar` exist (≈:282); var() palette.

## Approach
- codeCopy: closest .code-card → its `pre code` textContent →
  `navigator.clipboard.writeText`; swap button label to "Copied" for ~1.5 s
  (guard concurrent clicks). Clipboard failure → label "Copy failed" briefly;
  never throws.
- codeExpand: remove `collapsed` from the card, remove/hide the button.
- CSS: `.code-card.md-fence` collapsed state (max-height ≈ 30×line-height,
  overflow hidden, bottom fade), `.code-expand` full-width subtle button,
  `.lang` label, katex block spacing, `.mermaid-card` (centered SVG, padded),
  `.mermaid-failed pre` visible, `.jump-bottom-pill` (floating, bottom-center
  of the thread scroll area, pill shape, subtle shadow — matches app chrome).
  Light/dark: follow how app.css handles theme vars elsewhere.
- Tests: delegation handler — codeCopy writes exact raw text (mock clipboard)
  + label swap + restore; codeExpand declassifies; unknown data-act ignored;
  wsOpenFile still works (regression).

## Constraints
- One delegated handler total in Message.tsx. No inline styles; app.css only.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; test count increased (report before/after)
- [ ] (assertional) copy yields the raw (unescaped) code text exactly; expand irreversible per card per render; existing wsOpenFile behavior untouched

## Dependencies
UNIT-101 (markup), UNIT-102 (Message effect coexists in same component — merge cleanly)
