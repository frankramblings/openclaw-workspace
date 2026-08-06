# Ledger — Phase 5 Retrieval

Working dir: `docs/thrifty/phase5-retrieval/`

## Units

| Unit | Title | Deps | Status | exec_model (observed) | surgical_n | redo_n | replan_n | Notes |
|------|-------|------|--------|-----------------------|-----------|--------|----------|-------|
| UNIT-401 | backend /api/palette | none | done | — | 1 | 0 | 0 | email source did live network I/O + item-level exceptions 500'd the endpoint; both surgically fixed |
| UNIT-402 | ⌘K palette UI | 401 | done | — | 1 | 0 | 0 | navigate.ts note stale-closure bug, palette.css fictional CSS vars, no history-layer/Esc-leak guard; all surgically fixed |
| UNIT-403 | thread markdown export | none | done | — | 1 | 0 | 0 | ChatHeader export/copy/PDF could fire on stale cross-session data mid switch; surgically fixed |

Status ∈ `pending` · `executing` · `checking` · `done` · `escalated`

## Run summary (2026-07-21, closed)

All units done (executor pass 1 honest + behavioral tests — hard rule 3
worked; checker 7 surgical fixes incl. the headline live-IMAP-per-keystroke
email source; orchestrator 2 integration fixes below). DEPLOY SMOKE MATTERED:
mocked tests were green while the live endpoint 500'd on real data. Final:
backend 1277 green; fe 314/311/3-known; live /api/palette returns ranked
cross-source results; transcribe/push endpoints unaffected. Executor ~111k
tokens (1 pass); checker ~283k. exec_model: unverified (self-report
haiku-4.5) for all units.

## Fix-loop log

- 2026-07-21 check (401/402/403 batched, adversarial assertional pass): 7 confirmed defects found and surgically fixed in place (see per-unit verdicts). All three units: diagnosis=local, tier=1 (surgical, done by checker). Regression tests added for every fix. Full gates re-run green after fixes: backend 1276 passed (was 1274 baseline + 2 new); frontend build clean, 311 passed / 3 known failures / 314 total (was 291 baseline + 23 new).
- 2026-07-21 orchestrator integration (post-deploy smoke): live /api/palette 500'd — real stores mix ISO-string and epoch timestamps (all-int fixtures hid it); `-r["_ts"]` sort crashed AFTER the per-item guards. Fixed with `_num_ts()` coercion at every ingestion + output site + regression test (1277th). Second smoke finding: sessions store epoch-MS vs notes/docs epoch-S → recency ties skewed; normalized ms→s in _num_ts. Both redeployed + live-verified (recents ts all 10-digit).
