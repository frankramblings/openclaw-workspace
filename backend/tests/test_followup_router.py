"""HTTP contract for the followup endpoints: session resolution (SPA id OR
gateway sessionKey), token enforcement, idempotent complete, and the auth-gate
allowlist that lets the wrapper ping through when a workspace token is set."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config, followup, sessions_store


@pytest.fixture
def client():
    return TestClient(app_module.app)


@pytest.fixture
def session_rec(monkeypatch):
    rec = {"id": "abc123def456", "sessionKey": "agent:main:web-abc123def456",
           "archived": False, "model": "openclaw"}

    def fake_get(sid):
        return rec if sid == rec["id"] else None

    def fake_id_for(key):
        return rec["id"] if key in (rec["sessionKey"], rec["id"]) else None

    monkeypatch.setattr(sessions_store, "get", fake_get)
    monkeypatch.setattr(sessions_store, "id_for_session_key", fake_id_for)
    return rec


@pytest.fixture(autouse=True)
def no_fire(monkeypatch):
    """The router spawns the turn-firing coroutine; tests only check spawn."""
    fired = []

    async def fake_fire(pid, *, overdue=False):
        fired.append((pid, overdue))
        return True

    monkeypatch.setattr(followup, "fire_followup", fake_fire)
    return fired


def test_register_by_spa_id_and_by_session_key(client, session_rec):
    r = client.post("/api/followup/register",
                    data={"session": "abc123def456", "label": "render 566"})
    assert r.status_code == 200 and r.json()["id"]
    r2 = client.post("/api/followup/register",
                     data={"session": "agent:main:web-abc123def456", "label": "x"})
    assert r2.status_code == 200
    p = followup.get_promise(r2.json()["id"])
    assert p["session_id"] == "abc123def456"


def test_register_unknown_session_404(client, session_rec):
    r = client.post("/api/followup/register", data={"session": "nope", "label": "x"})
    assert r.status_code == 404


def test_complete_fires_once(client, session_rec, no_fire):
    pid = client.post("/api/followup/register",
                      data={"session": "abc123def456", "label": "t"}).json()["id"]
    r = client.post("/api/followup/complete",
                    data={"id": pid, "exit_code": "0", "duration_s": "12.5",
                          "tail": "done"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    r2 = client.post("/api/followup/complete", data={"id": pid, "exit_code": "1"})
    assert r2.json().get("ignored") is True
    assert no_fire == [(pid, False)]
    r3 = client.post("/api/followup/complete", data={"id": "nope", "exit_code": "0"})
    assert r3.status_code == 404


def test_token_enforced_when_configured(client, session_rec, monkeypatch):
    monkeypatch.setenv("FOLLOWUP_TOKEN", "sekret")
    r = client.post("/api/followup/register",
                    data={"session": "abc123def456", "label": "t"})
    assert r.status_code == 401
    r2 = client.post("/api/followup/register",
                     data={"session": "abc123def456", "label": "t"},
                     headers={"X-Workspace-Token": "sekret"})
    assert r2.status_code == 200


def test_gate_allowlists_wrapper_paths(client, session_rec, monkeypatch):
    """With a workspace token set, register/complete pass the GLOBAL gate
    (the router's own token check still applies) but list stays gated."""
    monkeypatch.setattr(config, "auth_token", lambda: "gate-tok")
    r = client.post("/api/followup/register",
                    data={"session": "abc123def456", "label": "t"},
                    headers={"X-Workspace-Token": "gate-tok"})
    assert r.status_code == 200        # allowlisted past gate; token matches
    r2 = client.get("/api/followup/list")
    assert r2.status_code == 401       # list is NOT allowlisted


def test_list_returns_promises(client, session_rec):
    client.post("/api/followup/register", data={"session": "abc123def456", "label": "t"})
    r = client.get("/api/followup/list")
    assert r.status_code == 200 and len(r.json()["promises"]) == 1
