"""HTTP contract for /api/chat/suggest: prompt assembly per mode, tail
truncation, sanitization, and hard fail-to-empty on bridge error/timeout."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config, suggest


@pytest.fixture
def client():
    return TestClient(app_module.app)


@pytest.fixture
def brain(monkeypatch):
    """Stub bridge.run_text inside the suggest module; records prompts."""
    calls = {"prompts": [], "reply": "Fix the granola cron job"}

    async def fake_run_text(prompt, session_key, model_ref=None):
        calls["prompts"].append(prompt)
        calls["session_key"] = session_key
        calls["model_ref"] = model_ref
        return calls["reply"]

    monkeypatch.setattr(suggest.bridge, "run_text", fake_run_text)
    return calls


def _post(client, **over):
    body = {"session_key": "abc", "mode": "followup",
            "context": "User: hi\n\nAssistant: hello"}
    body.update(over)
    return client.post("/api/chat/suggest", json=body)


def test_followup_happy_path(client, brain):
    r = _post(client)
    assert r.status_code == 200
    assert r.json() == {"text": "Fix the granola cron job"}
    p = brain["prompts"][0]
    assert "User: hi" in p and "next" in p.lower()
    assert brain["model_ref"] == config.SUGGEST_MODEL
    assert brain["session_key"].endswith("-suggester")


def test_midturn_prompt_variant(client, brain):
    r = _post(client, mode="midturn")
    assert r.status_code == 200
    assert "While you wait" in brain["prompts"][0]


def test_unknown_mode_treated_as_followup(client, brain):
    r = _post(client, mode="bogus")
    assert r.status_code == 200
    assert "While you wait" not in brain["prompts"][0]


def test_empty_context_short_circuits(client, brain):
    r = _post(client, context="   ")
    assert r.json() == {"text": ""}
    assert brain["prompts"] == []          # never called the model


def test_context_truncated_to_tail(client, brain):
    ctx = "x" * 5000 + "TAIL-MARKER"
    _post(client, context=ctx)
    p = brain["prompts"][0]
    assert "TAIL-MARKER" in p
    # the prompt embeds at most 4000 context chars
    assert "x" * 4001 not in p


def test_bridge_error_returns_empty(client, brain, monkeypatch):
    async def boom(prompt, session_key, model_ref=None):
        raise RuntimeError("gateway down")
    monkeypatch.setattr(suggest.bridge, "run_text", boom)
    r = _post(client)
    assert r.status_code == 200
    assert r.json() == {"text": ""}


def test_timeout_returns_empty(client, monkeypatch):
    async def slow(prompt, session_key, model_ref=None):
        await asyncio.sleep(0.2)
        return "too late"
    monkeypatch.setattr(suggest.bridge, "run_text", slow)
    monkeypatch.setattr(suggest, "_TIMEOUT_S", 0.05)
    r = _post(client)
    assert r.json() == {"text": ""}


def test_sanitize_strips_quotes_and_extra_lines(client, brain):
    brain["reply"] = '"While you wait, fix the cron job"\nSecond line ignored'
    r = _post(client, mode="midturn")
    assert r.json() == {"text": "While you wait, fix the cron job"}


def test_sanitize_rejects_overlong(client, brain):
    brain["reply"] = "y" * 200
    r = _post(client)
    assert r.json() == {"text": ""}
