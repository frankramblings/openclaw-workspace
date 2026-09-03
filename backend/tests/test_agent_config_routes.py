"""Status + audit routes for the agent-config surfaces."""
import pytest
from fastapi.testclient import TestClient

from backend import agent_config_store as store
from backend import gateway_admin as gw
from backend.app import app
from backend.tests.fake_gateway import FakeGateway


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _agent_cache_reset():
    gw._AGENT_CACHE.update(id=None, ts=0.0)


def test_status_reports_switch_agent_and_counts(client, monkeypatch):
    monkeypatch.setenv("WORKSPACE_AGENT_CONFIG_WRITES", "0")
    FakeGateway({"agents.list": {"defaultId": "main", "agents": [{"id": "main"}]}}).install(monkeypatch)
    store.audit("mcp.add", "x", True)
    r = client.get("/api/agent-config/status")
    assert r.status_code == 200
    body = r.json()
    assert body == {"ok": True, "writes_enabled": False, "agent_id": "main",
                    "backups_dir": str(store.base_dir() / "backups"), "audit_entries": 1}


def test_status_survives_gateway_outage(client, monkeypatch):
    FakeGateway({"agents.list": OSError("down")}).install(monkeypatch)
    body = client.get("/api/agent-config/status").json()
    assert body["ok"] is True and body["agent_id"] is None and body["writes_enabled"] is True


def test_audit_route_newest_first_with_limit(client):
    store.audit("mcp.add", "a", True)
    store.audit("mcp.remove", "a", True)
    r = client.get("/api/agent-config/audit?limit=1")
    assert r.status_code == 200
    assert [e["action"] for e in r.json()["entries"]] == ["mcp.remove"]
    assert client.get("/api/agent-config/audit?limit=0").status_code == 400
    assert client.get("/api/agent-config/audit?limit=501").status_code == 400
