"""Router tests: entities action branch (confirm/reclassify/not_entity) + undo."""
import json

import pytest
from httpx import ASGITransport, AsyncClient

import backend.inbox as inbox
from backend.inbox import entities_store, settings, state


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def client(tmp_path, monkeypatch):
    # isolate inbox state
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(state, "_mem", None)
    # isolate the entity vault dir
    ent_dir = tmp_path / "Entities"
    ent_dir.mkdir()
    (ent_dir / "People_Pending_Overrides.json").write_text("{}\n")
    (ent_dir / "Entity_Denylist.md").write_text("# Entity Denylist\n\n")
    monkeypatch.setattr(settings, "entities_dir", lambda: ent_dir)

    # register a stub entities source so the router accepts source=entities
    async def fake_entities():
        return [{"id": "automation suite", "source": "entities",
                 "title": "Automation Suite", "subtitle": "guessed: project",
                 "snippet": "", "ts": 1, "ageHours": 0.0, "score": 40,
                 "meta": {"canon": "automation suite", "guessType": "project",
                          "name": "Automation Suite"},
                 "actions": ["confirm", "not_entity"]}]
    monkeypatch.setitem(inbox.SOURCES, "entities", fake_entities)
    inbox._cache.clear()

    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t"), ent_dir


@pytest.mark.anyio
async def test_confirm_writes_verified_override(client):
    c, ent_dir = client
    async with c as cl:
        r = await cl.post("/api/items/action", json={
            "source": "entities", "id": "automation suite", "action": "confirm",
            "type": "project", "title": "Automation Suite",
            "meta": {"canon": "automation suite", "name": "Automation Suite"}})
        assert r.status_code == 200 and r.json()["ok"] is True
        undo_ts = r.json()["undoTs"]
    ov = json.loads((ent_dir / "People_Pending_Overrides.json").read_text())
    assert ov["automation suite"] == {"type": "project", "verified": True}
    # undo removes it again
    async with AsyncClient(transport=c._transport, base_url="http://t") as cl:
        r = await cl.post("/api/items/undo", json={"ts": undo_ts})
        assert r.status_code == 200
    assert "automation suite" not in entities_store.load_overrides(ent_dir)


@pytest.mark.anyio
async def test_not_entity_appends_denylist(client):
    c, ent_dir = client
    async with c as cl:
        r = await cl.post("/api/items/action", json={
            "source": "entities", "id": "automation suite", "action": "not_entity",
            "title": "Automation Suite",
            "meta": {"canon": "automation suite", "name": "Automation Suite"}})
        assert r.status_code == 200
    assert "automation suite" in entities_store.load_denylist(ent_dir)
