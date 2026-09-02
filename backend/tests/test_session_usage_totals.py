"""Task 2: `_project_session_usage` gains a `totals` block + `costed` flag on
top of the existing footer contract, so the client (Task 3) can render session
totals without re-deriving them from `usage`.

`_project_session_usage(spa_session_id, session_key, payload, live)` matches a
row out of `payload["sessions"]` via `_match_usage_row`; with a single-row
`sessions` list (no `key`/`sessionId` match needed) it falls back to that lone
row, so wrapping ROW in `{"sessions": [ROW]}` is how these tests hand it a row
directly (the brief's literal `..., ROW, live={})` call assumed `payload` WAS
the row; the real signature needs it inside a `sessions` list)."""
from backend import bridge

ROW = {
    "usage": {"input": 1200, "output": 300, "cacheRead": 10, "cacheWrite": 4,
              "totalTokens": 1514, "totalCost": 0.0, "missingCostEntries": 3,
              "messageCounts": {"assistant": 2}},
    "contextWeight": {},
    "model": "claude-cli/claude-opus-4-8",
}


def test_projection_adds_totals_and_costed():
    payload = {"sessions": [ROW]}
    out = bridge._project_session_usage("spa1", "agent:main:web:spa1", payload, live={})
    assert out["ok"] is True
    assert out["totals"] == {"input": 1200, "output": 300, "cacheRead": 10, "cacheWrite": 4,
                             "totalTokens": 1514, "totalCost": 0.0, "missingCostEntries": 3}
    assert out["costed"] is False


def test_totals_default_to_zero_when_usage_missing():
    payload = {"sessions": [{"usage": {}, "contextWeight": {}}]}
    out = bridge._project_session_usage("spa1", "agent:main:web:spa1", payload, live={})
    assert out["totals"]["totalTokens"] == 0 and out["costed"] is False
