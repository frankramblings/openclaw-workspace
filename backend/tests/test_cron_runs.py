"""Unit tests for the cron run-history mappers."""
from backend.cron import _map_run, _runs_list


def test_map_run_prefers_run_at_and_truncates_long_text():
    out = _map_run({"ts": 1, "runAtMs": 2, "status": "error",
                    "durationMs": 1234, "summary": "s" * 600,
                    "error": "boom", "delivered": False})
    assert out["ts"] == 2
    assert out["status"] == "error"
    assert out["durationMs"] == 1234
    assert len(out["summary"]) == 500
    assert out["error"] == "boom"
    assert out["delivered"] is False


def test_map_run_defaults():
    out = _map_run({"ts": 7})
    assert out["ts"] == 7
    assert out["status"] == "ok"
    assert out["summary"] == "" and out["error"] == ""


def test_runs_list_tolerates_container_shapes():
    assert _runs_list({"entries": [{"a": 1}]}) == [{"a": 1}]
    assert _runs_list({"runs": [1]}) == [1]
    assert _runs_list({"logs": [2]}) == [2]
    assert _runs_list([3]) == [3]
    assert _runs_list({"nope": 4}) == []
