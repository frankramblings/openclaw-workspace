# Ledger — Phase 3 Message Actions

Working dir: `docs/thrifty/phase3-message-actions/`

## Units

| Unit | Title | Deps | Status | exec_model (observed) | surgical_n | redo_n | replan_n | Notes |
|------|-------|------|--------|-----------------------|-----------|--------|----------|-------|
| UNIT-201 | edit-and-resend | none | done | unverified (self-report haiku-4.5) | 1 | 0 | 0 | checker fix: empty-text+attachments validation order; probes for index-0/consecutive-user/guards |
| UNIT-202 | retry-with-model | 201 | done | unverified (self-report haiku-4.5) | 2 | 0 | 0 | pass 1 deleted 4 committed tests (disclosed; restored+adapted pass 2, assertions intact); checker fix: retry-menu Escape close |

Status ∈ `pending` · `executing` · `checking` · `done` · `escalated`

## Run summary (2026-07-20, closed)

Both units done. Executor pass 1: features solid but deleted 4 committed
phase-2 interaction tests ("mock complications") — DISCLOSED under the hard
rules, routed back, restored byte-identical with adapted mocks. Checker
(Sonnet, surgical authority) fixes: editMessage rejected empty-text-with-
attachments (validation ordering vs contract); retry menu had outside-click
close but no Escape. +21 checker probes. Flagged, not fixed: Continue button
nested inside retry wrapper (cosmetic); send() sync-throw race shared with
regenerate (systemic, pre-existing). Final gate (orchestrator): 260 tests /
257 pass / 3 known pre-existing; build clean; no new deps, no bundle change.
Deployed via dist. Executor ~245k tokens (2 passes); checker ~133k.

## Fix-loop log

- 2026-07-20 pass 1 (fresh Haiku executor ae49da18c7cc6f968): 201+202 built; rule-2 violation disclosed (4 committed tests deleted). Routed back with committed file extracted to scratchpad.
- 2026-07-20 pass 2: all 8 committed Message.test.tsx tests restored name-identical, assertions intact (orchestrator diffed names vs 2a7e77f); +9 real new tests vs baseline (pass-1 "+13" claim was inflated).
- 2026-07-20 checker (Sonnet ab6854f6f3429c1ed, batched, surgical): 2 local defects fixed, +21 probes. Gate re-verified by orchestrator: 260/257/3.
