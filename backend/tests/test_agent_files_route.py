"""Agent files (SOUL.md and friends) through agents.files.*: allowlist,
sha256 optimistic concurrency, pre-write backup, restore, kill switch."""
import pytest
from fastapi.testclient import TestClient

from backend import agent_config_store as store
from backend import agent_files
from backend import gateway_admin as gw
from backend.app import app
from backend.tests.fake_gateway import FakeGateway

CUR = "You are Gary.\n"
SHA_CUR = store.sha256_text(CUR)


def file_payload(name, content=CUR, missing=False):
    f = {"name": name, "path": f"/ws/{name}", "missing": missing}
    if not missing:
        f.update(size=len(content), updatedAtMs=1700000000000, content=content)
    return {"agentId": "main", "workspace": "/ws", "file": f}


def responses(content=CUR, missing=False):
    """A stateful fake: set() updates what the next get() returns, so a
    write-then-restore round trip sees its own writes."""
    state = {"content": content, "missing": missing}

    def get(p):
        return file_payload(p["name"], state["content"], state["missing"])

    def set_(p):
        state.update(content=p["content"], missing=False)
        return {"ok": True, **file_payload(p["name"], p["content"])}

    return {
        "agents.list": {"defaultId": "main", "agents": [{"id": "main"}]},
        "agents.files.list": {"agentId": "main", "workspace": "/ws",
                              "files": [{"name": "SOUL.md", "path": "/ws/SOUL.md", "missing": False, "size": 13, "updatedAtMs": 1},
                                        {"name": "MEMORY.md", "path": "/ws/MEMORY.md", "missing": True}]},
        "agents.files.get": get,
        "agents.files.set": set_,
    }


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _agent_cache_reset():
    gw._AGENT_CACHE.update(id=None, ts=0.0)


def test_list_relays_files(client, monkeypatch):
    FakeGateway(responses()).install(monkeypatch)
    r = client.get("/api/agent/files")
    assert r.status_code == 200
    body = r.json()
    assert body["agent_id"] == "main" and body["workspace"] == "/ws"
    assert body["files"] == [{"name": "SOUL.md", "path": "/ws/SOUL.md", "missing": False, "size": 13, "updated_at_ms": 1},
                             {"name": "MEMORY.md", "path": "/ws/MEMORY.md", "missing": True, "size": None, "updated_at_ms": None}]


def test_get_returns_content_and_sha(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    r = client.get("/api/agent/files/SOUL.md")
    assert r.status_code == 200
    f = r.json()["file"]
    assert f["content"] == CUR and f["sha256"] == SHA_CUR and f["missing"] is False and f["updated_at_ms"] == 1700000000000
    assert fake.calls_for("agents.files.get") == [{"agentId": "main", "name": "SOUL.md"}]


def test_get_missing_file_has_empty_content_sha(client, monkeypatch):
    FakeGateway(responses(missing=True)).install(monkeypatch)
    f = client.get("/api/agent/files/BOOTSTRAP.md").json()["file"]
    assert f["missing"] is True and f["content"] == "" and f["sha256"] == store.sha256_text("")


def test_name_outside_allowlist_is_400_before_gateway(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    for path in ("/api/agent/files/NOPE.md", "/api/agent/files/soul.md", "/api/agent/files/..%2FSOUL.md"):
        r = client.get(path)
        assert r.status_code == 400 and r.json()["error"] == "bad_name", path
    assert client.put("/api/agent/files/NOPE.md", json={"content": "x"}).status_code == 400
    assert fake.calls == []


def test_put_backs_up_then_sets_and_audits(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    r = client.put("/api/agent/files/SOUL.md", json={"content": "You are Gary v2.\n", "base_sha256": SHA_CUR})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["file"]["sha256"] == store.sha256_text("You are Gary v2.\n")
    assert fake.calls_for("agents.files.set") == [{"agentId": "main", "name": "SOUL.md", "content": "You are Gary v2.\n"}]
    backups = store.list_backups("agent-file", "main/SOUL.md")
    assert len(backups) == 1 and backups[0]["id"] == body["backup_id"] and backups[0]["sha256"] == SHA_CUR
    assert store.read_backup("agent-file", "main/SOUL.md", body["backup_id"]) == CUR
    entry = store.recent_audit()[0]
    assert entry["action"] == "agent_file.set" and entry["target"] == "main/SOUL.md" and entry["bytes"] == 17


def test_put_unchanged_content_is_a_noop(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    r = client.put("/api/agent/files/SOUL.md", json={"content": CUR})
    assert r.status_code == 200 and r.json()["unchanged"] is True
    assert fake.calls_for("agents.files.set") == [] and store.list_backups("agent-file", "main/SOUL.md") == []
    assert store.recent_audit() == []


def test_put_stale_sha_is_409_with_current(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    r = client.put("/api/agent/files/SOUL.md", json={"content": "new", "base_sha256": "0" * 64})
    assert r.status_code == 409 and r.json()["error"] == "stale" and r.json()["current_sha256"] == SHA_CUR
    assert fake.calls_for("agents.files.set") == []


def test_put_force_overrides_stale_sha(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    r = client.put("/api/agent/files/SOUL.md", json={"content": "new", "base_sha256": "0" * 64, "force": True})
    assert r.status_code == 200 and len(fake.calls_for("agents.files.set")) == 1


def test_put_missing_file_writes_without_backup(client, monkeypatch):
    fake = FakeGateway(responses(missing=True)).install(monkeypatch)
    r = client.put("/api/agent/files/BOOTSTRAP.md", json={"content": "fresh"})
    assert r.status_code == 200 and r.json()["backup_id"] is None
    assert len(fake.calls_for("agents.files.set")) == 1


def test_put_rejects_bad_content(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    assert client.put("/api/agent/files/SOUL.md", json={"content": "a\x00b"}).status_code == 400
    assert client.put("/api/agent/files/SOUL.md", json={"content": 5}).status_code == 400
    assert client.put("/api/agent/files/SOUL.md", json={}).status_code == 400
    big = "x" * (agent_files.AGENT_FILE_MAX_BYTES + 1)
    r = client.put("/api/agent/files/SOUL.md", json={"content": big})
    assert r.status_code == 413 and r.json()["error"] == "too_large"
    assert fake.calls == []


def test_put_gateway_failure_is_audited(client, monkeypatch):
    FakeGateway(responses()).error("agents.files.set", "INVALID_REQUEST", 'unsafe workspace file "SOUL.md"').install(monkeypatch)
    r = client.put("/api/agent/files/SOUL.md", json={"content": "new"})
    assert r.status_code == 400 and r.json()["error"] == "bad_name"
    assert store.recent_audit()[0]["ok"] is False


def test_backups_list_and_restore_round_trip(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    first = client.put("/api/agent/files/SOUL.md", json={"content": "v2"}).json()["backup_id"]
    listed = client.get("/api/agent/files/SOUL.md/backups").json()
    assert listed["ok"] is True and [b["id"] for b in listed["backups"]] == [first]
    r = client.post("/api/agent/files/SOUL.md/restore", json={"backup_id": first})
    assert r.status_code == 200, r.text
    assert fake.calls_for("agents.files.set")[-1]["content"] == CUR
    assert len(store.list_backups("agent-file", "main/SOUL.md")) == 2
    assert store.recent_audit()[0]["action"] == "agent_file.restore"


def test_restore_unknown_backup_is_404(client, monkeypatch):
    fake = FakeGateway(responses()).install(monkeypatch)
    r = client.post("/api/agent/files/SOUL.md/restore", json={"backup_id": "20260903T000000000000-deadbeef"})
    assert r.status_code == 404 and r.json()["error"] == "backup_not_found"
    assert client.post("/api/agent/files/SOUL.md/restore", json={}).status_code == 400
    assert fake.calls_for("agents.files.set") == []


def test_writes_disabled_blocks_put_and_restore(client, monkeypatch):
    monkeypatch.setenv("WORKSPACE_AGENT_CONFIG_WRITES", "0")
    fake = FakeGateway(responses()).install(monkeypatch)
    assert client.put("/api/agent/files/SOUL.md", json={"content": "x"}).status_code == 503
    assert client.post("/api/agent/files/SOUL.md/restore", json={"backup_id": "20260903T000000000000-deadbeef"}).status_code == 503
    assert fake.calls == []
