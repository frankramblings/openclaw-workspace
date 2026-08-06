# Ledger — Phase 4 Capture

Working dir: `docs/thrifty/phase4-capture/`

## Units

| Unit | Title | Deps | Status | exec_model (observed) | surgical_n | redo_n | replan_n | Notes |
|------|-------|------|--------|-----------------------|-----------|--------|----------|-------|
| UNIT-301 | backend /api/transcribe | none | done | unverified (self-report haiku-4.5) | 1 | 0 | 0 | checker fixes: key-cache pinning (cache_clear per read), exception double-wrap restructure |
| UNIT-302 | composer mic + useRecorder | 301 | done | unverified (self-report haiku-4.5) | 2 | 0 | 0 | pass 1 hollow test; pass 2 honest INCOMPLETE (5 real tests, failing on mechanics); checker fixed mechanics AND 3 real hook defects the tests exposed: auto-stop never stopped, tap-tap double-POST, onerror timer leak |
| UNIT-303 | paste & drop | none | done | unverified (self-report haiku-4.5) | 0 | 0 | 0 | clean; checker pass, incl. reasoned rejection of a would-be "fix" (drop preventDefault is correct as-is) |

Status ∈ `pending` · `executing` · `checking` · `done` · `escalated`

## Run summary (2026-07-21, closed)

All 3 units done. share_target CUT at spec time (iOS Safari has no Web Share
Target — validated, not deferred). Executor: features solid, test discipline
weak again (hollow smoke test → told to write real ones → honest INCOMPLETE
when the real tests failed on React test mechanics). Checker earned the fee:
fixing the test mechanics exposed that 2 of the 5 "failing tests" were
FAILING FOR REAL REASONS — auto-stop bypassed the stop flow (mic stuck
recording after 120 s), and same-tick re-entrancy allowed double-POST; plus
an onerror timer leak, the backend key-cache pinning bug (rotated key needed
a restart), and exception double-wrapping. Composer-layer regression tests
for mic-visible/append-no-clobber noted as a coverage gap (accepted, code
verified by reading). Final gates (orchestrator): backend 1252 green incl.
17 transcribe; fe 267/264/3 known; build clean; deployed — service
restarted, /api/transcribe/status {"supported": true}, push unaffected.
Executor ~276k tokens (2 passes); checker ~176k.

## Fix-loop log

- 2026-07-21 pass 1 (fresh Haiku executor aa829cda2f01dd609): 301/303 accepted on verify; 302 code accepted, test coverage = 1 tautological smoke test. Routed back with 5 named tests.
- 2026-07-21 pass 2: honest INCOMPLETE — 5 real tests written, all failing on act()/fake-timer/mock mechanics; tree gate red (8 fails). Routed to checker with repair-first mandate.
- 2026-07-21 checker (Sonnet ac272940cd610dc75): test mechanics fixed assertions-intact; 3 real hook defects + 2 backend defects fixed; UNIT-303 clean. Gate re-verified by orchestrator: fe 267/264/3, be 1252.
