"""Per-tab availability from binaries/config/connection-enable. Core tabs are
always available; account tabs report available:false with a reason+hint."""
import pytest

from backend import capabilities as caps


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(caps.config, "load_connection", lambda: {})
    return monkeypatch


def test_core_tabs_always_available(env):
    m = caps.snapshot()
    for tab in ("chat", "memory", "skills", "cron", "notes", "documents"):
        assert m[tab]["available"] is True


def test_email_unavailable_without_himalaya(env):
    env.setattr(caps.shutil, "which", lambda _: None)
    m = caps.snapshot()
    assert m["email"]["available"] is False
    assert "himalaya" in m["email"]["reason"].lower()


def test_email_needs_enable_even_with_binary(env, tmp_path):
    env.setattr(caps.shutil, "which", lambda _: "/usr/local/bin/himalaya")
    env.setattr(caps, "_himalaya_config_present", lambda: True)
    # integration not enabled in connection.json
    m = caps.snapshot()
    assert m["email"]["available"] is False
    assert "enable" in m["email"]["hint"].lower()


def test_email_available_when_enabled_and_present(env):
    env.setattr(caps.shutil, "which", lambda _: "/usr/local/bin/himalaya")
    env.setattr(caps, "_himalaya_config_present", lambda: True)
    env.setattr(caps.config, "load_connection",
                lambda: {"integrations": {"email": True}})
    m = caps.snapshot()
    assert m["email"]["available"] is True
