"""Branding config (the configurable agent name) + the /api/config endpoint.

The agent name is the headline shippable feature: one value, sourced from
env > .data/branding.json > default, propagated everywhere."""
import json

import pytest
from fastapi.testclient import TestClient

from backend import config
from backend.app import app


@pytest.fixture
def isolated_branding(tmp_path, monkeypatch):
    """Point branding at a tmp file and clear the env override."""
    path = tmp_path / "branding.json"
    monkeypatch.setattr(config, "BRANDING_PATH", path)
    monkeypatch.delenv("WORKSPACE_AGENT_NAME", raising=False)
    monkeypatch.delenv("WORKSPACE_ACCENT", raising=False)
    return path


def test_default_when_unset(isolated_branding):
    assert config.agent_name() == config.DEFAULT_AGENT_NAME
    assert config.accent_color() == config.DEFAULT_ACCENT


def test_branding_file_wins_over_default(isolated_branding):
    isolated_branding.write_text(json.dumps({"agent_name": "Gary", "accent": "#abcdef"}))
    assert config.agent_name() == "Gary"
    assert config.accent_color() == "#abcdef"


def test_env_wins_over_file(isolated_branding, monkeypatch):
    isolated_branding.write_text(json.dumps({"agent_name": "Gary"}))
    monkeypatch.setenv("WORKSPACE_AGENT_NAME", "Jarvis")
    assert config.agent_name() == "Jarvis"


def test_blank_name_falls_back_to_default(isolated_branding):
    isolated_branding.write_text(json.dumps({"agent_name": "   "}))
    assert config.agent_name() == config.DEFAULT_AGENT_NAME


def test_save_branding_merges_and_persists(isolated_branding, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", isolated_branding.parent)
    config.save_branding(agent_name="Friday")
    config.save_branding(accent="#112233")  # must not wipe agent_name
    saved = json.loads(isolated_branding.read_text())
    assert saved == {"agent_name": "Friday", "accent": "#112233"}


def test_corrupt_branding_file_is_ignored(isolated_branding):
    isolated_branding.write_text("{ not json")
    assert config.agent_name() == config.DEFAULT_AGENT_NAME


def test_api_config_endpoint(isolated_branding, monkeypatch):
    monkeypatch.setenv("WORKSPACE_AGENT_NAME", "Gary")
    body = TestClient(app).get("/api/config").json()
    assert body["agent_name"] == "Gary"
    assert "accent" in body
