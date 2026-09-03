"""MCP servers through the gateway's own config (mcp.servers via
config.get / config.patch). The fake gateway serves a snapshot whose `path`
points at a tmp copy of an openclaw.json so the on-disk backup is real."""
import json

import pytest
from fastapi.testclient import TestClient

from backend import agent_config_store as store
from backend import mcp_servers, settings_status
from backend.app import app
from backend.tests.fake_gateway import FakeGateway

SERVERS = {
    "wistia": {"url": "https://api.wistia.com/mcp/api", "transport": "streamable-http", "auth": "oauth",
               "headers": {"X-Token": "<redacted>"}},
    "local-fs": {"command": "npx", "args": ["-y", "fs-mcp"], "env": {"HOME": "<redacted>"}, "enabled": False,
                 "connectionTimeoutMs": 5000, "toolFilter": {"include": ["read_*"]}},
}


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def cfg(tmp_path):
    path = tmp_path / "openclaw.json"
    path.write_text(json.dumps({"mcp": {"servers": SERVERS}, "gateway": {"auth": {"password": "s3cret"}}}))
    return path


def snapshot(path, servers=SERVERS, h="hash-1"):
    return {"path": str(path), "exists": True, "valid": True, "hash": h,
            "parsed": {"mcp": {"servers": servers}}, "config": {"mcp": {"servers": servers}}}


def install(monkeypatch, path, servers=SERVERS, patch_result=None):
    fake = FakeGateway({"config.get": snapshot(path, servers),
                        "config.patch": patch_result if patch_result is not None else {"ok": True, "path": str(path)}})
    return fake.install(monkeypatch)


# --- read --------------------------------------------------------------------

def test_list_maps_http_and_stdio_servers_sorted(client, monkeypatch, cfg):
    install(monkeypatch, cfg)
    r = client.get("/api/mcp/servers")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["source"] == "gateway" and body["hash"] == "hash-1"
    assert body["path"] == str(cfg)
    names = [s["id"] for s in body["servers"]]
    assert names == ["local-fs", "wistia"]
    fs, wi = body["servers"]
    assert fs["transport"] == "stdio" and fs["command"] == "npx" and fs["args"] == ["-y", "fs-mcp"]
    assert fs["is_enabled"] is False and fs["env_names"] == ["HOME"] and "env" not in fs
    assert fs["timeouts"] == {"connect_ms": 5000} and fs["tool_filter"] == {"include": ["read_*"]}
    assert wi["transport"] == "streamable-http" and wi["url"].startswith("https://")
    assert wi["is_enabled"] is True and wi["needs_oauth"] is True and wi["auth"] == "oauth"
    assert wi["header_names"] == ["X-Token"] and "headers" not in wi
    assert wi["status"] == "configured" and wi["tool_count"] is None and wi["error"] is None


def test_list_without_mcp_section_is_empty(client, monkeypatch, cfg):
    FakeGateway({"config.get": {"path": str(cfg), "hash": "h", "parsed": {}}}).install(monkeypatch)
    assert client.get("/api/mcp/servers").json()["servers"] == []


def test_list_gateway_failure_is_an_error_envelope(client, monkeypatch):
    FakeGateway({"config.get": OSError("refused")}).install(monkeypatch)
    r = client.get("/api/mcp/servers")
    assert r.status_code == 502
    assert r.json()["ok"] is False and r.json()["error"] == "gateway_unreachable"


# --- validation (pure) ---------------------------------------------------------

def test_validate_http_server_minimal_defaults_transport():
    name, srv = mcp_servers.validate_new_server({"name": "docs", "url": "https://x.example/mcp"})
    assert name == "docs" and srv == {"url": "https://x.example/mcp", "transport": "streamable-http"}


def test_validate_stdio_server_with_args_env_cwd_enabled():
    name, srv = mcp_servers.validate_new_server({"name": "fs", "command": "npx", "args": ["a"], "env": {"K": "v"},
                                                 "cwd": "/tmp", "enabled": False, "requestTimeoutMs": 10})
    assert srv == {"command": "npx", "args": ["a"], "env": {"K": "v"}, "cwd": "/tmp", "enabled": False,
                   "requestTimeoutMs": 10}


@pytest.mark.parametrize("body,fragment", [
    ({"url": "https://x/"}, "name"),
    ({"name": "bad name", "url": "https://x/"}, "name"),
    ({"name": "-lead", "url": "https://x/"}, "name"),
    ({"name": "x" * 65, "url": "https://x/"}, "name"),
    ({"name": "a"}, "exactly one of url or command"),
    ({"name": "a", "url": "https://x/", "command": "y"}, "exactly one of url or command"),
    ({"name": "a", "url": "ftp://x/"}, "http(s)"),
    ({"name": "a", "url": "https://user:pw@x/"}, "credentials"),
    ({"name": "a", "url": "https://x/", "transport": "stdio"}, "transport"),
    ({"name": "a", "url": "https://x/", "args": ["z"]}, "args only applies"),
    ({"name": "a", "command": "c", "transport": "sse"}, "transport does not apply"),
    ({"name": "a", "command": "c", "headers": {"h": "v"}}, "headers only applies"),
    ({"name": "a", "command": "c", "args": "not-a-list"}, "args must be"),
    ({"name": "a", "command": "c", "env": {"k": 1}}, "env must be"),
    ({"name": "a", "url": "https://x/", "enabled": "yes"}, "enabled must be"),
    ({"name": "a", "url": "https://x/", "auth": "basic"}, "auth must be"),
    ({"name": "a", "url": "https://x/", "oauth": {"nope": "x"}}, "oauth accepts"),
    ({"name": "a", "url": "https://x/", "toolFilter": {"include": []}}, "toolFilter accepts"),
    ({"name": "a", "url": "https://x/", "connectionTimeoutMs": 0}, "positive integer"),
    ({"name": "a", "url": "https://x/", "connectionTimeoutMs": True}, "positive integer"),
    ({"name": "a", "url": "https://x/", "bogus": 1}, "unknown field"),
    ("not a dict", "JSON object"),
])
def test_validate_rejects(body, fragment):
    with pytest.raises(mcp_servers.BadRequest) as ei:
        mcp_servers.validate_new_server(body)
    assert fragment in str(ei.value)


def test_patch_fragment_is_scoped_to_one_server():
    frag = mcp_servers.mcp_patch_fragment("docs", {"url": "https://x/"})
    assert frag == {"mcp": {"servers": {"docs": {"url": "https://x/"}}}}
    assert list(frag) == ["mcp"] and list(frag["mcp"]) == ["servers"] and list(frag["mcp"]["servers"]) == ["docs"]
    assert mcp_servers.mcp_patch_fragment("docs", None) == {"mcp": {"servers": {"docs": None}}}


# --- add -----------------------------------------------------------------------

def test_add_backs_up_then_patches_with_base_hash(client, monkeypatch, cfg):
    fake = install(monkeypatch, cfg)
    r = client.post("/api/mcp/servers", json={"name": "docs", "url": "https://x.example/mcp", "enabled": False})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["ok"] is True and body["server"]["id"] == "docs" and body["server"]["is_enabled"] is False
    (patch,) = fake.calls_for("config.patch")
    assert patch["baseHash"] == "hash-1"
    assert json.loads(patch["raw"]) == {"mcp": {"servers": {"docs": {"url": "https://x.example/mcp", "transport": "streamable-http", "enabled": False}}}}
    assert "note" in patch
    backups = store.list_backups("openclaw-json", "config")
    assert len(backups) == 1 and backups[0]["id"] == body["backup_id"]
    assert "s3cret" in store.read_backup("openclaw-json", "config", body["backup_id"])
    assert store.recent_audit()[0]["action"] == "mcp.add" and store.recent_audit()[0]["ok"] is True
    assert [m for m, _ in fake.calls] == ["config.get", "config.patch"]


def test_add_existing_is_409_without_patch_or_backup(client, monkeypatch, cfg):
    fake = install(monkeypatch, cfg)
    r = client.post("/api/mcp/servers", json={"name": "wistia", "url": "https://x/"})
    assert r.status_code == 409 and r.json()["error"] == "exists"
    assert fake.calls_for("config.patch") == [] and store.list_backups("openclaw-json", "config") == []
    assert store.recent_audit()[0]["action"] == "mcp.add" and store.recent_audit()[0]["ok"] is False


def test_add_bad_body_is_400_before_gateway(client, monkeypatch, cfg):
    fake = install(monkeypatch, cfg)
    r = client.post("/api/mcp/servers", json={"name": "bad name", "url": "https://x/"})
    assert r.status_code == 400 and r.json()["error"] == "bad_request"
    assert fake.calls == []


def test_add_retries_once_on_stale_hash_then_409(client, monkeypatch, cfg):
    seen = {"n": 0}

    def patch(params):
        seen["n"] += 1
        return {"__error__": {"code": "INVALID_REQUEST", "message": "config changed since last load; re-run config.get and retry"}}

    FakeGateway({"config.get": snapshot(cfg), "config.patch": patch}).install(monkeypatch)
    r = client.post("/api/mcp/servers", json={"name": "docs", "url": "https://x/"})
    assert r.status_code == 409 and r.json()["error"] == "stale_config"
    assert seen["n"] == 2
    assert store.recent_audit()[0]["ok"] is False


def test_add_stale_then_ok_succeeds(client, monkeypatch, cfg):
    seen = {"n": 0}

    def patch(params):
        seen["n"] += 1
        if seen["n"] == 1:
            return {"__error__": {"code": "INVALID_REQUEST", "message": "config changed since last load; re-run config.get and retry"}}
        return {"ok": True, "path": str(cfg)}

    fake = FakeGateway({"config.get": snapshot(cfg), "config.patch": patch}).install(monkeypatch)
    r = client.post("/api/mcp/servers", json={"name": "docs", "url": "https://x/"})
    assert r.status_code == 201
    assert [m for m, _ in fake.calls] == ["config.get", "config.patch", "config.get", "config.patch"]


def test_add_gateway_validation_error_is_502_with_detail(client, monkeypatch, cfg):
    FakeGateway({"config.get": snapshot(cfg)}).error(
        "config.patch", "INVALID_REQUEST", "invalid config: mcp.servers.docs.url Invalid url").install(monkeypatch)
    r = client.post("/api/mcp/servers", json={"name": "docs", "url": "https://x/"})
    assert r.status_code == 502 and r.json()["error"] == "gateway_error"
    assert "Invalid url" in r.json()["detail"]


def test_add_refuses_when_backup_impossible(client, monkeypatch, tmp_path):
    install(monkeypatch, tmp_path / "missing.json")
    r = client.post("/api/mcp/servers", json={"name": "docs", "url": "https://x/"})
    assert r.status_code == 500 and r.json()["error"] == "backup_failed"


def test_writes_disabled_short_circuits_every_write(client, monkeypatch, cfg):
    monkeypatch.setenv("WORKSPACE_AGENT_CONFIG_WRITES", "0")
    fake = install(monkeypatch, cfg)
    for method, url, body in (("post", "/api/mcp/servers", {"name": "d", "url": "https://x/"}),
                              ("delete", "/api/mcp/servers/wistia", None),
                              ("post", "/api/mcp/servers/wistia/enabled", {"enabled": False})):
        r = getattr(client, method)(url, json=body) if body is not None else getattr(client, method)(url)
        assert r.status_code == 503 and r.json()["error"] == "writes_disabled"
    assert fake.calls == [] and store.recent_audit() == []


# --- remove / enabled ---------------------------------------------------------

def test_remove_patches_null_and_backs_up(client, monkeypatch, cfg):
    fake = install(monkeypatch, cfg)
    r = client.delete("/api/mcp/servers/wistia")
    assert r.status_code == 200 and r.json()["removed"] == "wistia"
    (patch,) = fake.calls_for("config.patch")
    assert json.loads(patch["raw"]) == {"mcp": {"servers": {"wistia": None}}}
    assert len(store.list_backups("openclaw-json", "config")) == 1
    assert store.recent_audit()[0]["action"] == "mcp.remove"


def test_remove_missing_is_404(client, monkeypatch, cfg):
    fake = install(monkeypatch, cfg)
    r = client.delete("/api/mcp/servers/nope")
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    assert fake.calls_for("config.patch") == []
    assert store.list_backups("openclaw-json", "config") == []
    assert store.recent_audit()[0]["action"] == "mcp.remove" and store.recent_audit()[0]["ok"] is False


def test_remove_bad_name_is_400(client, monkeypatch, cfg):
    fake = install(monkeypatch, cfg)
    assert client.delete("/api/mcp/servers/bad%20name").status_code == 400
    assert fake.calls == []


def test_enabled_toggle_patches_only_the_flag(client, monkeypatch, cfg):
    fake = install(monkeypatch, cfg)
    r = client.post("/api/mcp/servers/wistia/enabled", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["server"]["is_enabled"] is False and r.json()["server"]["url"].startswith("https://")
    (patch,) = fake.calls_for("config.patch")
    assert json.loads(patch["raw"]) == {"mcp": {"servers": {"wistia": {"enabled": False}}}}
    assert store.recent_audit()[0]["action"] == "mcp.enabled"


def test_enabled_requires_boolean(client, monkeypatch, cfg):
    fake = install(monkeypatch, cfg)
    assert client.post("/api/mcp/servers/wistia/enabled", json={"enabled": "no"}).status_code == 400
    assert client.post("/api/mcp/servers/wistia/enabled", json={}).status_code == 400
    assert fake.calls == []


# --- the mcporter surface is gone ------------------------------------------------

def test_mcporter_routes_and_helpers_are_removed(client):
    assert not hasattr(settings_status, "_mcporter_json")
    assert not hasattr(settings_status, "_MCP_CACHE")
    assert client.post("/api/mcp/servers/wistia/reconnect").status_code in (404, 405)
    assert client.get("/api/mcp/servers/wistia/tools").status_code in (404, 405)
