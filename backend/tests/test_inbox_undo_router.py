"""Router tests for v2.1: delete action, history logging, undo endpoints."""
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
    monkeypatch.setattr(state, "_mem", None)
    inbox._cache.clear()

    async def fake_gmail():
        return [{"id": "g1", "source": "gmail", "title": "Weekly digest",
                 "subtitle": "News", "snippet": "", "ts": 2, "ageHours": 1.0,
                 "score": 5, "meta": {"from": "news@x.com", "uid": "g1"},
                 "actions": ["archive", "delete", "dismiss", "snooze"]}]

    for name in list(inbox.SOURCES):
        monkeypatch.setitem(inbox.SOURCES, name, fake_gmail)

    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest.fixture
def fake_mail(monkeypatch):
    calls = []

    async def fake_move(uid, src, dest):
        calls.append(("move", uid, src, dest))

    async def fake_find(folder, subject, from_addr):
        calls.append(("find", folder, subject, from_addr))
        return "999"

    monkeypatch.setattr(inbox.email_himalaya, "move_message", fake_move)
    monkeypatch.setattr(inbox.email_himalaya, "find_uid", fake_find)
    return calls


@pytest.mark.anyio
async def test_delete_action_moves_to_trash_and_logs(client, fake_mail):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "delete",
                               "title": "Weekly digest",
                               "meta": {"from": "news@x.com"}})
        body = r.json()
        assert body["ok"] is True and isinstance(body["undoTs"], int)
        h = (await c.get("/api/items/history")).json()["entries"]
    assert fake_mail[0] == ("move", "g1", "INBOX", inbox.email_himalaya.TRASH_FOLDER)
    assert h[0]["action"] == "delete" and h[0]["undoable"] is True
    assert state.stats()["gmail:news@x.com"] == {"delete": 1}


@pytest.mark.anyio
async def test_undo_delete_moves_back_and_restores(client, fake_mail):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "delete",
                               "title": "Weekly digest",
                               "meta": {"from": "news@x.com"}})
        ts = r.json()["undoTs"]
        r2 = await c.post("/api/items/undo", json={"ts": ts})
        assert r2.json()["ok"] is True
        feed = (await c.get("/api/items?sources=gmail")).json()
    # find in Trash by subject+from, then move 999 back to INBOX
    assert ("find", inbox.email_himalaya.TRASH_FOLDER,
            "Weekly digest", "news@x.com") in fake_mail
    assert ("move", "999", inbox.email_himalaya.TRASH_FOLDER, "INBOX") in fake_mail
    assert [i["id"] for i in feed["items"]] == ["g1"]        # card is back
    assert state.stats() == {}                                # counter dropped
    assert state.history() == []                              # entry consumed


@pytest.mark.anyio
async def test_undo_local_dismiss(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1",
                               "action": "dismiss", "title": "Weekly digest"})
        ts = r.json()["undoTs"]
        await c.post("/api/items/undo", json={"ts": ts})
        feed = (await c.get("/api/items?sources=gmail")).json()
    assert [i["id"] for i in feed["items"]] == ["g1"]


@pytest.mark.anyio
async def test_undo_unknown_ts_404(client):
    async with client as c:
        r = await c.post("/api/items/undo", json={"ts": 123456})
    assert r.status_code == 404


@pytest.mark.anyio
async def test_archive_failure_does_not_dismiss(client, monkeypatch):
    async def boom(uid, src, dest):
        raise RuntimeError("imap down")
    monkeypatch.setattr(inbox.email_himalaya, "move_message", boom)
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1",
                               "action": "archive", "title": "Weekly digest"})
        feed = (await c.get("/api/items?sources=gmail")).json()
    assert r.status_code == 502
    assert [i["id"] for i in feed["items"]] == ["g1"]   # NOT hidden — bug fixed
    assert state.history() == []                         # nothing logged
