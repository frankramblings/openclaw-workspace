"""Router-level tests: merge, error isolation, hidden filtering, actions."""
import pytest
from httpx import ASGITransport, AsyncClient

import backend.inbox as inbox
from backend.inbox import state


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
    state._mem = None

    async def fake_gmail():
        return [{"id": "g1", "source": "gmail", "title": "Mail", "subtitle": "",
                 "snippet": "", "ts": 2, "ageHours": 1.0, "score": 5,
                 "meta": {}, "actions": ["archive", "dismiss", "snooze"]}]

    async def fake_slack():
        raise RuntimeError("signals stale")

    monkeypatch.setitem(inbox.SOURCES, "gmail", fake_gmail)
    monkeypatch.setitem(inbox.SOURCES, "slack", fake_slack)
    monkeypatch.setitem(inbox.SOURCES, "asana", fake_gmail)   # reuse shape
    monkeypatch.setitem(inbox.SOURCES, "obsidian", fake_gmail)

    inbox._cache.clear()

    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest.mark.anyio
async def test_merge_isolates_source_errors(client):
    async with client as c:
        r = await c.get("/api/items?sources=gmail,slack")
    body = r.json()
    assert [i["id"] for i in body["items"]] == ["g1"]
    assert "slack" in body["errors"]
    assert body["sources"] == {"gmail": 1, "slack": 0}


@pytest.mark.anyio
async def test_dismissed_items_filtered_and_action_endpoint(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "dismiss"})
        assert r.json()["ok"] is True
        r2 = await c.get("/api/items?sources=gmail")
    assert r2.json()["items"] == []


@pytest.mark.anyio
async def test_snooze_requires_until(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "snooze"})
    assert r.status_code == 400


@pytest.mark.anyio
async def test_unknown_action_rejected(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "explode"})
    assert r.status_code == 400
