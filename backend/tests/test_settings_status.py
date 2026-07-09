"""Behavioral tests for settings_status.py (Connections + MCP-servers view).

email_config/calendar_config read real on-disk config files (himalaya
config.toml, the Google-calendar-mcp tokens.json) — tested against tmp files,
no faking needed. The one real external boundary is the `mcporter` CLI
subprocess: rather than mocking asyncio.create_subprocess_exec, tests point
_MCPORTER_BIN at a tiny real executable shell script that echoes canned JSON
(and, for the caching test, counts its own invocations) — a real subprocess
runs end to end, only the specific external binary is swapped for a stand-in,
matching this suite's "real files/real calls, not mock theater" style.
"""
from __future__ import annotations

import json
import textwrap

import pytest
from fastapi.testclient import TestClient

from backend import settings_status


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_mcp_cache():
    settings_status._MCP_CACHE["data"] = None
    settings_status._MCP_CACHE["ts"] = 0.0
    yield
    settings_status._MCP_CACHE["data"] = None
    settings_status._MCP_CACHE["ts"] = 0.0


def _fake_mcporter(tmp_path, body: str) -> str:
    """A real executable standing in for the mcporter binary: `mcporter list
    --config ... --json` -> canned JSON on stdout."""
    script = tmp_path / "fake_mcporter"
    script.write_text(f"#!/bin/sh\ncat <<'JSON'\n{body}\nJSON\n")
    script.chmod(0o755)
    return str(script)


def _counting_mcporter(tmp_path, calls_file) -> str:
    """Like _fake_mcporter but increments calls_file on every invocation, so
    tests can assert the subprocess ran exactly N times (cache hit/miss)."""
    calls_file.write_text("0")
    script = tmp_path / "counting_mcporter"
    script.write_text(textwrap.dedent(f"""\
        #!/bin/sh
        n=$(cat {calls_file})
        n=$((n+1))
        echo $n > {calls_file}
        echo '{{"servers": []}}'
        """))
    script.chmod(0o755)
    return str(script)


# --- /api/email/config: himalaya config.toml ---------------------------------

@pytest.mark.anyio
async def test_email_config_reads_himalaya_account_shape(tmp_path, monkeypatch):
    cfg = tmp_path / "config.toml"
    cfg.write_text(textwrap.dedent("""\
        [accounts.gmail]
        email = "me@gmail.com"
        default = true

        [accounts.gmail.backend]
        type = "imap"
        host = "imap.gmail.com"
        port = 993

        [accounts.gmail.message.send.backend]
        type = "smtp"
        host = "smtp.gmail.com"
        port = 465
        """))
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", cfg)

    out = await settings_status.email_config()

    assert out == {
        "enabled": True, "provider": "himalaya", "address": "me@gmail.com",
        "imap_host": "imap.gmail.com", "imap_port": 993,
        "smtp_host": "smtp.gmail.com", "smtp_port": 465,
    }
    assert isinstance(out["imap_port"], int) and isinstance(out["smtp_port"], int)


@pytest.mark.anyio
async def test_email_config_missing_file_is_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", tmp_path / "nope.toml")
    assert await settings_status.email_config() == {"enabled": False}


@pytest.mark.anyio
async def test_email_config_corrupt_toml_is_disabled_not_raised(tmp_path, monkeypatch):
    cfg = tmp_path / "config.toml"
    cfg.write_text("not [ valid toml")
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", cfg)
    assert await settings_status.email_config() == {"enabled": False}


@pytest.mark.anyio
async def test_email_config_valid_toml_without_accounts_table_still_enabled(tmp_path, monkeypatch):
    cfg = tmp_path / "config.toml"
    cfg.write_text("# valid toml, no [accounts.*] table\n")
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", cfg)

    out = await settings_status.email_config()

    assert out["enabled"] is True
    assert out["address"] == "" and out["imap_host"] == ""


@pytest.mark.anyio
async def test_email_config_save_is_a_managed_externally_ack():
    out = await settings_status.email_config_save({"host": "ignored"})
    assert out == {"ok": True, "managed_externally": True}


# --- /api/calendar/config: reused Google token file --------------------------

@pytest.mark.anyio
async def test_calendar_config_reads_normal_account_shape(tmp_path, monkeypatch):
    tok = tmp_path / "tokens.json"
    tok.write_text(json.dumps({"normal": {"scope": "https://www.googleapis.com/auth/calendar"}}))
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tok)

    out = await settings_status.calendar_config()

    assert out == {"enabled": True, "provider": "google", "type": "google",
                   "connected": True, "scope": "https://www.googleapis.com/auth/calendar"}


@pytest.mark.anyio
async def test_calendar_config_falls_back_to_first_account_without_normal_key(tmp_path, monkeypatch):
    tok = tmp_path / "tokens.json"
    tok.write_text(json.dumps({"work": {"scope": "cal.readonly"}}))
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tok)

    out = await settings_status.calendar_config()

    assert out["scope"] == "cal.readonly"


@pytest.mark.anyio
async def test_calendar_config_missing_file_is_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tmp_path / "nope.json")
    assert await settings_status.calendar_config() == {"enabled": False}


@pytest.mark.anyio
async def test_calendar_config_corrupt_json_is_disabled_not_raised(tmp_path, monkeypatch):
    tok = tmp_path / "tokens.json"
    tok.write_text("{not valid json")
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tok)
    assert await settings_status.calendar_config() == {"enabled": False}


@pytest.mark.anyio
async def test_calendar_config_save_is_a_managed_externally_ack():
    out = await settings_status.calendar_config_save({})
    assert out == {"ok": True, "managed_externally": True}


# --- _is_local / _map_server: pure shape helpers ------------------------------

def test_is_local_true_for_local_source_kind():
    assert settings_status._is_local({"source": {"kind": "local"}}) is True


def test_is_local_false_for_import_or_missing_source():
    assert settings_status._is_local({"source": {"kind": "import"}}) is False
    assert settings_status._is_local({}) is False


def test_map_server_shape_keys_and_types():
    srv = {"name": "vault", "description": "Vault MCP", "status": "ok",
           "tools": [{"name": "a"}, {"name": "b"}], "transport": "stdio"}
    out = settings_status._map_server(srv)

    assert set(out) == {"id", "name", "status", "is_enabled", "needs_oauth",
                        "tool_count", "enabled_tool_count", "error", "transport"}
    assert out["id"] == "vault" and out["name"] == "Vault MCP"
    assert out["status"] == "ok"
    assert out["is_enabled"] is True and out["needs_oauth"] is False
    assert out["tool_count"] == 2 and out["enabled_tool_count"] == 2
    assert isinstance(out["tool_count"], int)
    assert out["error"] is None
    assert out["transport"] == "stdio"


def test_map_server_needs_oauth_when_status_is_auth():
    out = settings_status._map_server({"name": "x", "status": "auth"})
    assert out["needs_oauth"] is True
    assert out["tool_count"] == 0  # tools missing/not-a-list degrades to 0, not a crash


def test_map_server_name_falls_back_to_raw_name_without_description():
    out = settings_status._map_server({"name": "raw-id"})
    assert out["name"] == "raw-id"
    assert out["status"] == "unknown"


def test_map_server_surfaces_error_or_issue_field():
    assert settings_status._map_server({"name": "x", "error": "boom"})["error"] == "boom"
    assert settings_status._map_server({"name": "x", "issue": "boom2"})["error"] == "boom2"


# --- _mcporter_json: real subprocess boundary, canned stand-in binary -------

@pytest.mark.anyio
async def test_mcporter_json_runs_subprocess_and_parses_json(tmp_path, monkeypatch):
    body = json.dumps({"servers": [{"name": "vault", "status": "ok"}]})
    monkeypatch.setattr(settings_status, "_MCPORTER_BIN", _fake_mcporter(tmp_path, body))
    monkeypatch.setattr(settings_status, "_MCPORTER_CONFIG", tmp_path / "mcporter.json")

    data = await settings_status._mcporter_json()

    assert data == {"servers": [{"name": "vault", "status": "ok"}]}


@pytest.mark.anyio
async def test_mcporter_json_caches_within_ttl_no_second_subprocess(tmp_path, monkeypatch):
    calls = tmp_path / "calls.count"
    monkeypatch.setattr(settings_status, "_MCPORTER_BIN", _counting_mcporter(tmp_path, calls))
    monkeypatch.setattr(settings_status, "_MCPORTER_CONFIG", tmp_path / "mcporter.json")

    await settings_status._mcporter_json()
    await settings_status._mcporter_json()  # must hit the cache, not re-invoke

    assert calls.read_text().strip() == "1"


@pytest.mark.anyio
async def test_mcporter_json_malformed_output_degrades_to_empty_servers(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_MCPORTER_BIN", _fake_mcporter(tmp_path, "not valid json"))
    monkeypatch.setattr(settings_status, "_MCPORTER_CONFIG", tmp_path / "mcporter.json")

    assert await settings_status._mcporter_json() == {"servers": []}


@pytest.mark.anyio
async def test_mcporter_json_missing_binary_degrades_to_empty_servers(tmp_path, monkeypatch):
    """The create_subprocess_exec call now sits inside _mcporter_json's
    try/except alongside communicate()/json.loads, so a genuinely-missing
    mcporter binary (FileNotFoundError) degrades to {"servers": []} the
    same way malformed output or a subprocess timeout does, instead of
    raising and taking down the caller."""
    monkeypatch.setattr(settings_status, "_MCPORTER_BIN", str(tmp_path / "does-not-exist-bin"))
    monkeypatch.setattr(settings_status, "_MCPORTER_CONFIG", tmp_path / "mcporter.json")

    assert await settings_status._mcporter_json() == {"servers": []}


# --- MCP routes ----------------------------------------------------------------

@pytest.mark.anyio
async def test_mcp_servers_route_filters_to_local_only(tmp_path, monkeypatch):
    body = json.dumps({"servers": [
        {"name": "vault", "status": "ok", "source": {"kind": "local"}, "tools": [{"name": "a"}]},
        {"name": "ramblebot", "status": "ok", "source": {"kind": "import"}},
    ]})
    monkeypatch.setattr(settings_status, "_MCPORTER_BIN", _fake_mcporter(tmp_path, body))
    monkeypatch.setattr(settings_status, "_MCPORTER_CONFIG", tmp_path / "mcporter.json")

    out = await settings_status.mcp_servers()

    assert [s["id"] for s in out["servers"]] == ["vault"]
    assert out["servers"][0]["tool_count"] == 1


@pytest.mark.anyio
async def test_mcp_server_tools_route_returns_named_and_raw_tools(tmp_path, monkeypatch):
    body = json.dumps({"servers": [
        {"name": "vault", "tools": [{"name": "search", "description": "find stuff"}, "raw_tool"]},
    ]})
    monkeypatch.setattr(settings_status, "_MCPORTER_BIN", _fake_mcporter(tmp_path, body))
    monkeypatch.setattr(settings_status, "_MCPORTER_CONFIG", tmp_path / "mcporter.json")

    out = await settings_status.mcp_server_tools("vault")

    assert out["tools"] == [
        {"name": "search", "description": "find stuff"},
        {"name": "raw_tool", "description": ""},
    ]


@pytest.mark.anyio
async def test_mcp_server_tools_route_unknown_server_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_MCPORTER_BIN",
                        _fake_mcporter(tmp_path, json.dumps({"servers": []})))
    monkeypatch.setattr(settings_status, "_MCPORTER_CONFIG", tmp_path / "mcporter.json")

    assert await settings_status.mcp_server_tools("nope") == {"tools": []}


@pytest.mark.anyio
async def test_mcp_reconnect_forces_a_fresh_subprocess_probe(tmp_path, monkeypatch):
    calls = tmp_path / "calls.count"
    monkeypatch.setattr(settings_status, "_MCPORTER_BIN", _counting_mcporter(tmp_path, calls))
    monkeypatch.setattr(settings_status, "_MCPORTER_CONFIG", tmp_path / "mcporter.json")

    await settings_status._mcporter_json()
    assert calls.read_text().strip() == "1"

    out = await settings_status.mcp_reconnect("vault")

    assert out == {"ok": True}
    assert calls.read_text().strip() == "2"  # cache was invalidated, not reused


# --- routes wired into the real app -------------------------------------------

def test_route_email_config_wired_into_app(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", tmp_path / "nope.toml")
    from backend.app import app
    client = TestClient(app)
    r = client.get("/api/email/config")
    assert r.status_code == 200
    assert r.json() == {"enabled": False}


def test_route_calendar_config_wired_into_app(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tmp_path / "nope.json")
    from backend.app import app
    client = TestClient(app)
    r = client.get("/api/calendar/config")
    assert r.status_code == 200
    assert r.json() == {"enabled": False}
