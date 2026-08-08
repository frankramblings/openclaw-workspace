"""Per-session sidecar recording answered AskUserQuestion choices (mirrors the
chat-attachment sidecar tests in attachments.py)."""
from backend import question_cards as qc


def test_record_then_answers_for_round_trips(tmp_path, monkeypatch):
    monkeypatch.setattr(qc, "_QCARD_DIR", tmp_path)
    qc.record_answer("sess1", "t1", "Blue")
    assert qc.answers_for("sess1") == {"t1": {"answered": True, "choice": "Blue"}}


def test_answers_for_missing_session_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(qc, "_QCARD_DIR", tmp_path)
    assert qc.answers_for("nope") == {}


def test_record_answer_empty_tool_id_no_write(tmp_path, monkeypatch):
    monkeypatch.setattr(qc, "_QCARD_DIR", tmp_path)
    qc.record_answer("sess1", "", "Blue")
    assert list(tmp_path.iterdir()) == []
