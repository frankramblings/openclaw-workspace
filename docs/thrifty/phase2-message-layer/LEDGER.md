# Ledger — Phase 2 Message Layer

Working dir: `docs/thrifty/phase2-message-layer/`

## Units

| Unit | Title | Deps | Status | exec_model (observed) | surgical_n | redo_n | replan_n | Notes |
|------|-------|------|--------|-----------------------|-----------|--------|----------|-------|
| UNIT-101 | pipeline markup (fences/math/mermaid) | none | done | unverified (self-report haiku-4.5) | 1 | 0 | 0 | checker: sentinel-collision crash fix (security), math-block shape fix, duplicate-class fix (collapse was dead) |
| UNIT-102 | lazy enhancers + Message effect | 101 | done | unverified (self-report haiku-4.5) | 1 | 0 | 0 | architect: full-hljs (312KB gz) → lib/common (~50KB gz); checker: source clean, probe tests added |
| UNIT-103 | copy/expand + styles | 101,102 | done | unverified (self-report haiku-4.5) | 1 | 0 | 0 | checker: copy label race fix (WeakMap timers); hollow tests replaced with real click tests |
| UNIT-104 | stick-to-bottom + pill | 102 | done | unverified (self-report haiku-4.5) | 1 | 0 | 0 | checker: jumpToBottom resync race (pinnedRef), pill status gating (streaming only) |

Status ∈ `pending` · `executing` · `checking` · `done` · `escalated`

## Run summary (2026-07-20, closed)

Executor pass 1 delivered ALL 4 units with an honest, accurate report (hard
rules in the dispatch prompt fixed phase-1's misreporting) — every claim
verified on disk first try. Orchestrator surgical at integration: full-hljs
import → highlight.js/lib/common. Sonnet checker (batched, with surgical
authority) found 6 real defects — sentinel-collision render crash (reachable
from plain chat text), dead math-block path, duplicate class attr (collapse
non-functional), copy-label double-click race, jumpToBottom resync race, pill
shown for non-streaming states — fixed all, added 21 tests incl. 12
adversarial XSS probes. Final gate (orchestrator re-run): 230 tests / 227
pass / 3 known pre-existing fails; build green; main 107.87 KB gzip ≤ 116
budget; katex/mermaid/hljs-common all separate lazy chunks. Deployed via
dist (static mount; no restart needed). NOT committed pending Frank.
Executor tokens ~120k (1 pass); checker ~186k.

## Fix-loop log

- 2026-07-20 pass 1 (fresh cached Haiku executor a0792837bdbbb248d): 101–104 built, report fully accurate (first time in program). Gates verified independently.
- 2026-07-20 architect surgical (UNIT-102): import('highlight.js') pulled full 190-language build as a 312KB-gzip lazy chunk; switched to lib/common. Chunk now ~50KB gzip.
- 2026-07-20 checker (Sonnet a8279a2c32c206539, batched 101–104, surgical authority): 6 defects fixed (see unit notes), +21 tests. Gate re-verified by orchestrator: 230/227/3.
