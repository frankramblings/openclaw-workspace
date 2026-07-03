"""/api/history rewrites a stored followup seed (user role) into the compact
⚙️ card line, alongside the existing websearch/terminal strips."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, followup, sessions_store


def test_history_rewrites_followup_seed(monkeypatch):
    rec = {"id": "abc123def456", "sessionKey": "k", "model": "openclaw"}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)
    seed = followup.seed_text("render 566", exit_code=0, duration_s=754, tail="x")

    async def fake_hist(session_key, limit=200, strict=False):
        return {"history": [
            {"role": "user", "content": "hey Gary, kick off the render"},
            {"role": "user", "content": seed},
            {"role": "assistant", "content": "566 landed: link"},
        ], "model": None}

    monkeypatch.setattr(bridge, "fetch_history", fake_hist)
    client = TestClient(app_module.app)
    hist = client.get("/api/history/abc123def456").json()["history"]
    assert hist[0]["content"] == "hey Gary, kick off the render"   # non-seed passthrough
    assert hist[1]["content"].startswith("⚙️ Background task · render 566")
    assert "[[followup]]" not in hist[1]["content"]
    assert hist[2]["content"] == "566 landed: link"
