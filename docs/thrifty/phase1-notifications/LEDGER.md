# Ledger — Phase 1 Notifications

Working dir: `docs/thrifty/phase1-notifications/`

## Units

| Unit | Title | Deps | Status | exec_model (observed) | surgical_n | redo_n | replan_n | Notes |
|------|-------|------|--------|-----------------------|-----------|--------|----------|-------|
| UNIT-001 | push.py core module | none | done | unverified (self-report haiku-4.5) | 0 | 0 | 0 | gate re-run by orchestrator: green |
| UNIT-002 | push HTTP endpoints | 001 | done | unverified (self-report haiku-4.5) | 0 | 0 | 0 | full be suite 1235 green |
| UNIT-003 | event wiring (followup+turn) | 001 | done | unverified (self-report haiku-4.5) | 0 | 0 | 0 | full be suite 1235 green |
| UNIT-004 | /next SW push handlers | 002 | done | unverified (self-report haiku-4.5) | 1 | 0 | 0 | checker fixed: dead ?_s= deeplink → /next/ root; badge-0 branch consistency |
| UNIT-005 | /next toggle+badge+ack | 002,004 | done | unverified (self-report haiku-4.5) | 2 | 1 | 0 | pass 2 built UI; pass 3 added 5 tests; pass 4 added 3 transition tests but DELETED 4 prior tests (regression) — bounds exhausted; architect restored the 4 tests + fixed enablePush missing res.ok check. Final gate 176 pass/179 total, 3 known pre-existing fails only |
| UNIT-006 | overlay shim + sync | 002,004 | done | unverified (self-report haiku-4.5) | 1 | 1 | 0 | pass 2 built+verified; architect surgical at integration: same 2 defect classes as 004 (fake `?_s=` deeplink → `/`, badge-0 branch); sync re-run, generated sw.js verified |

Status ∈ `pending` · `executing` · `checking` · `done` · `escalated`

## Run summary (2026-07-20, closed)

All 6 units done. Deployed: backend restarted 18:24 EDT (VAPID keys live,
/api/push/status 200), overlay synced (gary-439c5f1ded), /next dist rebuilt.
Observed executor model: self-reported haiku-4.5 across all 4 passes,
uncorroborated by per-call cost (harness exposes tokens, not price) — ledger
policy: unverified. Subagent spend: executor ~413k tokens / 4 passes; checker
(sonnet) ~111k. Savings vs single-strong-model build: real but conservatively
unquantifiable given unverified tier; the dominant cost was the orchestrator
session, consistent with the skill's own benchmark note. Quality pattern for
future runs: this Haiku executor required independent verification EVERY pass —
2 silent omissions, 2 inflated claims, 1 test-deleting regression; the
verify-everything protocol caught all five.

## Fix-loop log

- 2026-07-20 checker (Sonnet, batched 001–004 assertional): 001/002/003 diagnosis=pass. 004 diagnosis=local, surgical applied by checker (2 defects: non-functional `?_s=` deeplink — nothing in /next reads it, replaced with contract-mandated `/next/` root fallback; badge-0 clearAppBadge branch inconsistency). node --check re-green. 004 → done.
- 2026-07-20 pass 1 (single cached Haiku executor, agent a65f4d7a6fefd300d): 001–004 built+verified; 005 partial (no settings UI); 006 silently skipped. Orchestrator verified gates independently: be 1235 green; fe build green; fe `npm test` has 3 PRE-EXISTING failures (confirmed present on committed state — design-cleanup commits, out of scope). Routed: continue same cached executor to finish 005 + build 006 (tier-2 continuation, redo_n=1 each).
