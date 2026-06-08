"""Connection resolution: env > .data/connection.json > openclaw.json > default.
Password is NEVER sourced from connection.json (a copied .data must not leak it)."""
import json

import pytest

from backend import config


@pytest.fixture
def iso(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CONNECTION_PATH", tmp_path / "connection.json")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    for v in ("OPENCLAW_GATEWAY_WS", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_AGENT_ID"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(config, "_openclaw_json", lambda: {})
    return monkeypatch


def test_gateway_ws_from_connection_file(iso, tmp_path):
    (tmp_path / "connection.json").write_text(json.dumps({"gateway_ws": "ws://box:9999"}))
    assert config.gateway_ws_url() == "ws://box:9999"


def test_gateway_ws_env_wins(iso, tmp_path):
    (tmp_path / "connection.json").write_text(json.dumps({"gateway_ws": "ws://box:9999"}))
    iso.setenv("OPENCLAW_GATEWAY_WS", "ws://env:1")
    assert config.gateway_ws_url() == "ws://env:1"


def test_gateway_ws_default_local(iso):
    assert config.gateway_ws_url().startswith("ws://127.0.0.1:")


def test_agent_id_from_connection_file(iso, tmp_path):
    (tmp_path / "connection.json").write_text(json.dumps({"agent_id": "scout"}))
    assert config.agent_id() == "scout"


def test_password_never_from_connection_file(iso, tmp_path):
    (tmp_path / "connection.json").write_text(json.dumps({"password": "leaked"}))
    assert config.gateway_password() in (None, "")  # not "leaked"


def test_save_connection_merges(iso, tmp_path):
    config.save_connection(gateway_ws="ws://a")
    config.save_connection(agent_id="scout")  # must not wipe gateway_ws
    saved = json.loads((tmp_path / "connection.json").read_text())
    assert saved == {"gateway_ws": "ws://a", "agent_id": "scout"}


def test_save_connection_allowlist_drops_secrets(iso, tmp_path):
    # Only CONNECTION_FIELDS persist; a stray token/secret is dropped.
    config.save_connection(gateway_ws="ws://a", token="sk-leak", password="pw",
                           integrations={"email": True})
    saved = json.loads((tmp_path / "connection.json").read_text())
    assert saved == {"gateway_ws": "ws://a", "integrations": {"email": True}}
    assert "token" not in saved and "password" not in saved
