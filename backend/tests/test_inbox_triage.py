"""Tests for the ✨ triage pass: prompt build, reply parse, endpoint."""
import json

import pytest
from httpx import ASGITransport, AsyncClient

import backend.inbox as inbox
from backend.inbox import recommend, state


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _item(i="1", source="gmail", score=5):
    return {"id": i, "source": source, "title": f"Item {i}", "subtitle": "S",
            "snippet": "snip", "ts": 1, "ageHours": 2.0, "score": score,
            "meta": {}, "actions": []}


def test_build_triage_prompt_caps_and_constrains():
    items = [_item(str(n), score=n) for n in range(130)]
    prompt, included = recommend.build_triage_prompt(items, cap=120)
    assert len(included) == 120
    assert "129" in prompt                      # highest score included
    assert json.dumps("archive") in prompt or "archive" in prompt
    assert "STRICT JSON" in prompt
    # per-source constraint table is spelled out
    assert "gmail: archive|delete|reply|gary|none" in prompt


def test_parse_triage_reply_tolerates_fences_and_junk():
    valid = {"1": "gmail", "m1": "slack"}
    text = ('Here you go!\n```json\n'
            '[{"id": "1", "action": "reply", "confidence": "high", "reason": "asks a question"},\n'
            ' {"id": "m1", "action": "delete", "confidence": "high", "reason": "x"},\n'
            ' {"id": "ghost", "action": "archive", "confidence": "low", "reason": "y"},\n'
            ' {"id": "1", "action": "explode"}]\n```\nHope that helps.')
    out = recommend.parse_triage_reply(text, valid, now_ms=42)
    # only the first entry survives: m1's 'delete' is not allowed for slack,
    # 'ghost' is an unknown id, the duplicate has an unknown action
    assert out == {"gmail:1": {"action": "reply", "confidence": "high",
                               "reason": "asks a question", "ts": 42}}


def test_parse_triage_reply_garbage_returns_empty():
    assert recommend.parse_triage_reply("sorry, I had a stall", {"1": "gmail"},
                                        now_ms=1) == {}


def test_parse_triage_reply_tolerates_trailing_prose_with_brackets():
    valid = {"1": "gmail"}
    text = ('[{"id": "1", "action": "archive", "confidence": "med", "reason": "bulk"}]\n'
            'Note: I skipped item [2] because it looked important.')
    out = recommend.parse_triage_reply(text, valid, now_ms=7)
    assert out == {"gmail:1": {"action": "archive", "confidence": "med",
                               "reason": "bulk", "ts": 7}}


def test_parse_triage_reply_tolerates_brackets_inside_strings():
    valid = {"1": "gmail"}
    text = ('```json\n[{"id": "1", "action": "archive", "confidence": "high", '
            '"reason": "[SOCIAL] thread is stale"}]\n```')
    out = recommend.parse_triage_reply(text, valid, now_ms=7)
    assert out["gmail:1"]["reason"] == "[SOCIAL] thread is stale"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(state, "_mem", None)
    inbox._cache.clear()

    async def fake_src():
        return [{**_item("1"), "meta": {"from": "x@y.z"}}]

    for name in list(inbox.SOURCES):
        monkeypatch.setitem(inbox.SOURCES, name, fake_src)

    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest.mark.anyio
async def test_triage_endpoint_caches_and_items_show_rec(client, monkeypatch):
    async def fake_run_text(prompt, session_key):
        assert session_key == inbox.config.inbox_triage_session_key()
        return '[{"id": "1", "action": "archive", "confidence": "high", "reason": "bulk"}]'
    monkeypatch.setattr(inbox.bridge, "run_text", fake_run_text)
    async with client as c:
        r = await c.post("/api/items/triage", json={})
        body = r.json()
        assert body["scored"] == 1
        feed = (await c.get("/api/items?sources=gmail")).json()
    rec = feed["items"][0]["rec"]
    assert rec["by"] == "ai" and rec["action"] == "archive"


@pytest.mark.anyio
async def test_triage_garbled_brain_503(client, monkeypatch):
    async def fake_run_text(prompt, session_key):
        return "no json here, codex stalled"
    monkeypatch.setattr(inbox.bridge, "run_text", fake_run_text)
    async with client as c:
        r = await c.post("/api/items/triage", json={})
    assert r.status_code == 503


@pytest.mark.anyio
async def test_spinoff_reply_intent_seeds_draft(client, monkeypatch):
    seen = {}

    async def fake_turn(seed, key, model):
        seen["seed"] = seed

    async def fake_read(uid, folder="INBOX", mark_seen=True):
        assert mark_seen is False
        return {"body": "original email body", "message_id": "<m@x>"}

    monkeypatch.setattr(inbox, "_agent_turn", fake_turn)
    monkeypatch.setattr(inbox.email_himalaya, "email_read", fake_read)
    monkeypatch.setattr(inbox.email_himalaya, "_load_style", lambda: "breezy")
    async with client as c:
        r = await c.post("/api/items/spinoff", json={
            "intent": "reply",
            "item": {"source": "gmail", "title": "Q about quotas",
                     "subtitle": "Ada", "snippet": "", "meta": {"uid": "55"}}})
    assert r.json().get("session_id")
    assert "original email body" in seen["seed"]
    assert "breezy" in seen["seed"]
    assert "Draft a reply" in seen["seed"]
