"""Per-turn timing telemetry: record shape + JSONL writer rotation."""
import json

from backend import app as app_module
from backend import config


def test_record_computes_ms_deltas_and_flags():
    run_info = {"timing": {"t_send": 1.0, "t_ack": 1.5, "t_first_frame": 2.0,
                           "t_first_text": 3.0, "t_end": 4.0},
                "stalled": False}
    rec = app_module._turn_timing_record(run_info, "agent:main:web-x",
                                         "openai/gpt-5.5",
                                         text_seen=True, failed=False,
                                         thinking="low")
    assert rec["ack_ms"] == 500
    assert rec["first_frame_ms"] == 1000
    assert rec["first_text_ms"] == 2000
    assert rec["total_ms"] == 3000
    assert rec["late_ms"] is None
    assert rec["model"] == "openai/gpt-5.5"
    assert rec["thinking"] == "low"
    assert rec["stalled"] is False and rec["retried"] is False
    assert rec["text_seen"] is True and rec["failed"] is False


def test_record_tolerates_empty_run_info():
    rec = app_module._turn_timing_record({}, "k", None,
                                         text_seen=False, failed=True)
    assert rec["ack_ms"] is None and rec["total_ms"] is None
    assert rec["model"] == "default"
    assert rec["thinking"] is None   # normal speed sends no override


def test_log_appends_jsonl_and_rotates_at_2mb(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    app_module._log_turn_timing({"a": 1})
    path = tmp_path / "turn_timings.jsonl"
    assert json.loads(path.read_text().strip()) == {"a": 1}

    path.write_text("x" * 2_000_001)
    app_module._log_turn_timing({"b": 2})
    assert (tmp_path / "turn_timings.jsonl.old").exists()
    assert json.loads(path.read_text().strip()) == {"b": 2}
