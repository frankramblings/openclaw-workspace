"""/api/history includes answered AskUserQuestion choices so the frontend can
replay a card locked; /api/question-answer records them (see
backend/question_cards.py)."""
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, question_cards as qc, sessions_store


def test_history_includes_question_answers(monkeypatch, tmp_path):
    monkeypatch.setattr(qc, "_QCARD_DIR", tmp_path)
    rec = {"id": "sess1", "sessionKey": "k", "model": "openclaw"}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)

    async def fake_hist(session_key, limit=200, strict=False):
        return {"history": [], "model": None}

    monkeypatch.setattr(bridge, "fetch_history", fake_hist)
    qc.record_answer("sess1", "t1", "Blue")

    client = TestClient(app_module.app)
    body = client.get("/api/history/sess1").json()
    assert body["question_answers"] == {"t1": {"answered": True, "choice": "Blue"}}


def test_question_answer_route_records_choice(monkeypatch, tmp_path):
    monkeypatch.setattr(qc, "_QCARD_DIR", tmp_path)
    client = TestClient(app_module.app)
    resp = client.post("/api/question-answer",
                        json={"session": "sess2", "tool_id": "t9", "choice": "Yes"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert qc.answers_for("sess2") == {"t9": {"answered": True, "choice": "Yes"}}


def test_question_answer_route_requires_fields(monkeypatch, tmp_path):
    monkeypatch.setattr(qc, "_QCARD_DIR", tmp_path)
    client = TestClient(app_module.app)
    resp = client.post("/api/question-answer", json={"session": "", "tool_id": "t9"})
    assert resp.status_code == 400
