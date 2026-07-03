"""The sweeper is the backstop: it re-fires completions recorded but never
fired (endpoint crash / service restart) and fires overdue turns for promises
whose wrapper went silent past the deadline. In-flight dedupe keeps the
endpoint-spawned fire and a sweep from double-firing."""
import asyncio
import time

import pytest

from backend import followup


@pytest.fixture
def fired(monkeypatch):
    calls = []

    async def fake_fire(pid, *, overdue=False):
        calls.append((pid, overdue))
        return True

    monkeypatch.setattr(followup, "fire_followup", fake_fire)
    return calls


def test_sweep_fires_recorded_and_overdue(fired):
    done = followup.create_promise("a", "k1", "t1", 3600)
    followup.record_completion(done["id"], exit_code=0, duration_s=1, tail="")
    late = followup.create_promise("b", "k2", "t2", 0)   # no deadline
    # Force a past deadline directly (mark() only leaves pending, so poke the store).
    over = followup.create_promise("c", "k3", "t3", 1)
    with followup._LOCK:
        data = followup._load()
        for p in data["promises"]:
            if p["id"] == over["id"]:
                p["deadline_ms"] = int(time.time() * 1000) - 1000
        followup._save(data)

    async def run():
        spawned = followup._sweep_once()
        await asyncio.sleep(0.05)   # let the spawned tasks run
        return spawned

    spawned = asyncio.run(run())
    assert set(spawned) == {done["id"], over["id"]}
    assert (done["id"], False) in fired
    assert (over["id"], True) in fired
    assert all(pid != late["id"] for pid, _ in fired)


def test_sweep_dedupes_inflight(fired):
    p = followup.create_promise("a", "k1", "t1", 3600)
    followup.record_completion(p["id"], exit_code=0, duration_s=1, tail="")

    async def run():
        followup._INFLIGHT.add(p["id"])
        try:
            return followup._sweep_once()
        finally:
            followup._INFLIGHT.discard(p["id"])

    assert asyncio.run(run()) == []


def test_complete_endpoint_dedupes_against_inflight_sweep(fired, monkeypatch):
    """The endpoint and the sweeper share one in-flight set: if a sweep
    already claimed this pid, the endpoint's spawn attempt is a no-op (but
    the completion is still recorded and the response still says ok)."""
    from fastapi.testclient import TestClient

    from backend import app as app_module, sessions_store

    rec = {"id": "sess1", "sessionKey": "agent:main:web-sess1", "archived": False}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)
    monkeypatch.setattr(sessions_store, "id_for_session_key",
                        lambda key: rec["id"] if key == rec["sessionKey"] else None)

    p = followup.create_promise(rec["id"], rec["sessionKey"], "t", 3600)
    followup._INFLIGHT.add(p["id"])
    try:
        client = TestClient(app_module.app)
        r = client.post("/api/followup/complete",
                        data={"id": p["id"], "exit_code": "0",
                              "duration_s": "1", "tail": ""})
        assert r.status_code == 200 and r.json() == {"ok": True}
    finally:
        followup._INFLIGHT.discard(p["id"])
    assert fired == []
