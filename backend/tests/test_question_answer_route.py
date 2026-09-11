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

    async def no_questions(method, params=None, timeout=30.0):
        return {"questions": []}

    monkeypatch.setattr(bridge, "gateway_call", no_questions)
    client = TestClient(app_module.app)
    resp = client.post("/api/question-answer",
                        json={"session": "sess2", "tool_id": "t9", "choice": "Yes"})
    assert resp.status_code == 200
    # Nothing pending on the Gateway (expired/replayed card) → the client falls
    # back to sending the answer as an ordinary message.
    assert resp.json() == {"ok": True, "resolved": False}
    assert qc.answers_for("sess2") == {"t9": {"answered": True, "choice": "Yes"}}


def test_question_answer_route_requires_fields(monkeypatch, tmp_path):
    monkeypatch.setattr(qc, "_QCARD_DIR", tmp_path)
    client = TestClient(app_module.app)
    resp = client.post("/api/question-answer", json={"session": "", "tool_id": "t9"})
    assert resp.status_code == 400


def test_resolve_pending_answers_the_gateway_question(monkeypatch):
    """The card's answer must resolve the PENDING gateway question, not ride in
    as a new chat turn — an unanswered AskUserQuestion blocks the session for
    its whole 900s timeout (reason=blocked_tool_call)."""
    calls = []

    async def fake_call(method, params=None, timeout=30.0):
        calls.append((method, params))
        if method == "question.list":
            return {"questions": [{
                "id": "ask_abc", "sessionKey": "agent:main:web-s1", "status": "pending",
                "questions": [{"questionId": "loc"}, {"questionId": "taste"}],
            }]}
        return {"status": "answered"}

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    out = qc.resolve_pending_sync("agent:main:web-s1", [["Portsmouth"], ["Thai", "Sushi"]])
    assert out == "resolved"
    assert calls[1][0] == "question.resolve"
    assert calls[1][1]["id"] == "ask_abc"
    assert calls[1][1]["answers"] == {"answers": {"loc": ["Portsmouth"],
                                                  "taste": ["Thai", "Sushi"]}}


def test_resolve_pending_reports_when_nothing_is_pending(monkeypatch):
    async def fake_call(method, params=None, timeout=30.0):
        return {"questions": []}

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    assert qc.resolve_pending_sync("agent:main:web-s1", [["Red"]]) == "no_pending"


def test_resolve_pending_ignores_another_sessions_question(monkeypatch):
    async def fake_call(method, params=None, timeout=30.0):
        return {"questions": [{"id": "ask_other", "sessionKey": "agent:main:web-OTHER",
                               "status": "pending", "questions": [{"questionId": "x"}]}]}

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    assert qc.resolve_pending_sync("agent:main:web-s1", [["Red"]]) == "no_pending"


def test_question_answer_route_resolves_and_reports_it(monkeypatch, tmp_path):
    monkeypatch.setattr(qc, "_QCARD_DIR", tmp_path)
    rec = {"id": "sess3", "sessionKey": "agent:main:web-sess3"}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)
    seen = {}

    async def fake_call(method, params=None, timeout=30.0):
        if method == "question.list":
            return {"questions": [{"id": "ask_z", "sessionKey": "agent:main:web-sess3",
                                   "status": "pending",
                                   "questions": [{"questionId": "color"}]}]}
        seen["resolve"] = params
        return {"status": "answered"}

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    client = TestClient(app_module.app)
    resp = client.post("/api/question-answer",
                       json={"session": "sess3", "tool_id": "t4", "choice": "Red",
                             "answers": [["Red"]]})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "resolved": True}
    assert seen["resolve"]["answers"] == {"answers": {"color": ["Red"]}}
    # The lock sidecar still records the choice for reload/replay.
    assert qc.answers_for("sess3")["t4"]["choice"] == "Red"
