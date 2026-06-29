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


@pytest.mark.anyio
async def test_complete_hides_obsidian_item(client, monkeypatch):
    """Completing a meeting action item clears it from the feed (no external
    task to close — that path is add_asana) and logs it as 'completed'."""
    async def fake_obsidian():
        return [{"id": "o1", "source": "obsidian", "title": "Send the deck",
                 "subtitle": "", "snippet": "", "ts": 2, "ageHours": 1.0,
                 "score": 5, "meta": {},
                 "actions": ["add_asana", "complete", "reviewed", "dismiss", "snooze"]}]

    monkeypatch.setitem(inbox.SOURCES, "obsidian", fake_obsidian)
    inbox._cache.clear()
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "obsidian", "id": "o1", "action": "complete"})
        assert r.json()["ok"] is True
        gone = await c.get("/api/items?sources=obsidian")
    assert gone.json()["items"] == []
    assert state.history(limit=1)[0]["action"] == "complete"


def test_spinoff_dedupes_recent_same_item(monkeypatch, tmp_path):
    """A runaway client hammered spinoff for one stuck item (~100 'Reply: Q
    about quotas' sessions in 5 days, each burning a seeding agent turn).
    Repeat spinoffs for the same item within the dedupe window must return
    the EXISTING session — no new session, no new seed turn."""
    import asyncio
    from backend import inbox
    from backend import sessions_store

    monkeypatch.setattr(sessions_store, "_STORE_FILE",
                        tmp_path / "sessions.json")
    seeded = []

    async def fake_turn(seed, key, model):
        seeded.append(key)
    monkeypatch.setattr(inbox, "_agent_turn", fake_turn)
    # Keep the caller-trail out of the real .data/spinoff.log
    monkeypatch.setattr(inbox, "_log_spinoff", lambda *a, **k: None)

    item = {"id": "slack-123", "source": "slack", "title": "Q about quotas",
            "subtitle": "#help", "snippet": "?", "meta": {}}
    first = asyncio.run(inbox.spinoff({"item": item}))
    second = asyncio.run(inbox.spinoff({"item": item}))
    assert first["session_id"] == second["session_id"]
    assert len(seeded) == 1, "second spinoff must not re-seed"
    assert second.get("deduped") is True


def test_cache_ttl_outlives_dot_poll():
    """The unread-dot polls every 120s; TTL must exceed it or every poll
    re-runs the gmail/slack/asana collectors (0.9s+ on the mini)."""
    from backend import inbox
    assert inbox.CACHE_TTL_MS >= 150_000


@pytest.mark.anyio
async def test_add_asana_creates_and_dismisses(client, monkeypatch):
    from backend.inbox import sources
    created = {}

    async def fake_create(name, notes, due_on, section_gid):
        created.update(name=name, notes=notes, due_on=due_on, section=section_gid)
        return "TASK123"

    monkeypatch.setattr(sources.asana, "create_task", fake_create)
    async with client as c:
        r = await c.post("/api/items/action", json={
            "source": "obsidian", "id": "abc", "action": "add_asana",
            "title": "Send Q3 deck to Taylor", "task": "Send Q3 deck to Taylor",
            "due": "2026-07-03", "meta": {"url": "obsidian://note"}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and isinstance(body["undoTs"], int)
    assert created["name"] == "Send Q3 deck to Taylor"
    assert created["due_on"] == "2026-07-03"
    assert "obsidian://note" in created["notes"]


@pytest.mark.anyio
async def test_add_asana_undo_deletes_task(client, monkeypatch):
    from backend.inbox import sources
    deleted = {}

    async def fake_create(name, notes, due_on, section_gid):
        return "T9"

    async def fake_delete(gid):
        deleted["gid"] = gid

    monkeypatch.setattr(sources.asana, "create_task", fake_create)
    monkeypatch.setattr(sources.asana, "delete_task", fake_delete)
    async with client as c:
        ts = (await c.post("/api/items/action", json={
            "source": "obsidian", "id": "z", "action": "add_asana",
            "title": "t"})).json()["undoTs"]
        r = await c.post("/api/items/undo", json={"ts": ts})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert deleted["gid"] == "T9"
