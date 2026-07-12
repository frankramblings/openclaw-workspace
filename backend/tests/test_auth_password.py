"""POST /api/auth/change-password: real verify-then-rotate over
config.OPENCLAW_CONFIG's gateway.auth.password.

Every test here monkeypatches config.OPENCLAW_CONFIG to a tmp_path file and
clears the config._openclaw_json() lru_cache on entry AND exit, so nothing
here ever reads or writes Frank's real ~/.openclaw/openclaw.json (see
test_connection.py's `iso` fixture for the established pattern this mirrors)."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from backend import config
from backend.app import app

client = TestClient(app)


@pytest.fixture
def oc_config(tmp_path, monkeypatch):
    path = tmp_path / "openclaw.json"
    path.write_text(json.dumps({
        "gateway": {"port": 18789, "auth": {"mode": "password", "password": "old-secret"}},
        "agents": {"list": [{"id": "main"}]},
    }))
    monkeypatch.setattr(config, "OPENCLAW_CONFIG", path)
    monkeypatch.delenv("OPENCLAW_GATEWAY_PASSWORD", raising=False)
    config._openclaw_json.cache_clear()
    yield path
    config._openclaw_json.cache_clear()


def _change(current, new):
    return client.post("/api/auth/change-password",
                        json={"current_password": current, "new_password": new})


def test_wrong_current_password_400s_and_does_not_write(oc_config):
    res = _change("nope", "brandnewpw")
    assert res.status_code == 400
    assert res.json()["detail"] == "current password is wrong"
    assert json.loads(oc_config.read_text())["gateway"]["auth"]["password"] == "old-secret"


def test_missing_current_password_400s(oc_config):
    res = _change("", "brandnewpw")
    assert res.status_code == 400
    assert res.json()["detail"] == "current password is wrong"


def test_new_password_too_short_rejected(oc_config):
    res = _change("old-secret", "short1")
    assert res.status_code == 400
    assert "8 characters" in res.json()["detail"]
    assert json.loads(oc_config.read_text())["gateway"]["auth"]["password"] == "old-secret"


def test_new_password_same_as_current_rejected(oc_config):
    res = _change("old-secret", "old-secret")
    assert res.status_code == 400
    assert "different" in res.json()["detail"]


def test_correct_current_password_rotates_it_and_preserves_other_keys(oc_config):
    res = _change("old-secret", "brandnewpw")
    assert res.status_code == 200
    assert res.json() == {"ok": True}

    on_disk = json.loads(oc_config.read_text())
    assert on_disk["gateway"]["auth"]["password"] == "brandnewpw"
    assert on_disk["gateway"]["auth"]["mode"] == "password"  # untouched
    assert on_disk["gateway"]["port"] == 18789               # untouched
    assert on_disk["agents"]["list"][0]["id"] == "main"      # untouched

    # This process picks up the new value immediately (lru_cache busted).
    assert config.gateway_password() == "brandnewpw"


def test_no_password_configured_400s(tmp_path, monkeypatch):
    path = tmp_path / "openclaw.json"
    path.write_text(json.dumps({"gateway": {"auth": {"mode": "none"}}}))
    monkeypatch.setattr(config, "OPENCLAW_CONFIG", path)
    monkeypatch.delenv("OPENCLAW_GATEWAY_PASSWORD", raising=False)
    config._openclaw_json.cache_clear()
    try:
        res = _change("anything", "brandnewpw")
        assert res.status_code == 400
        assert "No password is configured" in res.json()["detail"]
    finally:
        config._openclaw_json.cache_clear()


def test_env_override_blocks_change_with_honest_error(oc_config, monkeypatch):
    monkeypatch.setenv("OPENCLAW_GATEWAY_PASSWORD", "env-secret")
    res = _change("env-secret", "brandnewpw")
    assert res.status_code == 400
    assert "OPENCLAW_GATEWAY_PASSWORD" in res.json()["detail"]
    # Never even attempted a write.
    assert json.loads(oc_config.read_text())["gateway"]["auth"]["password"] == "old-secret"
