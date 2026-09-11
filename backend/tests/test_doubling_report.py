"""The client-side doubling sink must record a report and never break a chat."""
import json

from backend import doubling_report_route


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(doubling_report_route.router)
    return TestClient(app)


def test_report_is_appended_as_one_jsonl_record(tmp_path, monkeypatch):
    path = tmp_path / "spa-doubling.jsonl"
    monkeypatch.setattr(doubling_report_route, "_REPORT_PATH", path)

    r = _client().post("/api/debug/doubling", json={
        "session": "web-abc", "turn_id": "t1",
        "detected": {"span": "Here's the answer.", "count": 2},
        "text": "Here's the answer. I'll research this. Here's the answer.",
        "frames": [{"type": "delta", "len": 18}],
    })

    assert r.status_code == 200 and r.json()["ok"] is True
    rec = json.loads(path.read_text().strip())
    assert rec["session"] == "web-abc"
    assert rec["count"] == 2
    assert rec["frames"] == [{"type": "delta", "len": 18}]


def test_a_malformed_body_is_a_no_op_not_a_500(tmp_path, monkeypatch):
    monkeypatch.setattr(doubling_report_route, "_REPORT_PATH", tmp_path / "d.jsonl")
    r = _client().post("/api/debug/doubling", content=b"not json",
                       headers={"content-type": "application/json"})
    assert r.status_code == 200 and r.json()["ok"] is False


def test_frames_and_text_are_capped(tmp_path, monkeypatch):
    path = tmp_path / "spa-doubling.jsonl"
    monkeypatch.setattr(doubling_report_route, "_REPORT_PATH", path)

    _client().post("/api/debug/doubling", json={
        "frames": [{"i": i} for i in range(5000)],
        "text": "x" * 50000,
    })

    rec = json.loads(path.read_text().strip())
    assert len(rec["frames"]) == doubling_report_route._MAX_FRAMES
    assert len(rec["text"]) == doubling_report_route._MAX_TEXT


def test_an_oversized_log_is_truncated_rather_than_grown(tmp_path, monkeypatch):
    path = tmp_path / "spa-doubling.jsonl"
    path.write_text("x" * (doubling_report_route._MAX_BYTES + 1))
    monkeypatch.setattr(doubling_report_route, "_REPORT_PATH", path)

    _client().post("/api/debug/doubling", json={"session": "fresh"})

    lines = path.read_text().strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["session"] == "fresh"
