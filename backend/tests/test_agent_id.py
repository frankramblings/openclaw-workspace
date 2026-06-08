"""Agent id derivation + session-key builders — the core portability fix.
On a different OpenClaw the agent id is not 'main'; keys must follow it."""
import pytest

from backend import config


@pytest.fixture
def iso(monkeypatch):
    for v in ("OPENCLAW_AGENT_ID", "OPENCLAW_SESSION_KEY", "OPENCLAW_WEB_SESSION_KEY",
              "OPENCLAW_WEB_SESSION_PREFIX", "OPENCLAW_INBOX_TRIAGE_SESSION_KEY"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(config, "_openclaw_json", lambda: {})
    monkeypatch.setattr(config, "load_connection", lambda: {})
    return monkeypatch


def test_agent_id_default_is_main(iso):
    assert config.agent_id() == "main"


def test_agent_id_from_openclaw_config(iso):
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "scout"}]}})
    assert config.agent_id() == "scout"


def test_agent_id_env_wins(iso):
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "scout"}]}})
    iso.setenv("OPENCLAW_AGENT_ID", "override")
    assert config.agent_id() == "override"


def test_session_keys_follow_agent_id(iso):
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "scout"}]}})
    assert config.session_key() == "agent:scout:main"
    assert config.web_session_key() == "agent:scout:web"
    assert config.web_session_prefix() == "agent:scout:web"
    assert config.inbox_triage_session_key() == "agent:scout:inbox-triage"


@pytest.mark.parametrize("env_var,fn,value", [
    ("OPENCLAW_SESSION_KEY", "session_key", "agent:custom:main"),
    ("OPENCLAW_WEB_SESSION_KEY", "web_session_key", "agent:custom:thing"),
    ("OPENCLAW_WEB_SESSION_PREFIX", "web_session_prefix", "agent:custom:web"),
    ("OPENCLAW_INBOX_TRIAGE_SESSION_KEY", "inbox_triage_session_key", "agent:custom:tri"),
])
def test_session_key_env_override_wins(iso, env_var, fn, value):
    iso.setenv(env_var, value)
    assert getattr(config, fn)() == value


def test_maintainer_parity(iso):
    """agent id 'main' => ALL keys byte-identical to the v1 constants."""
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "main"}]}})
    assert config.session_key() == "agent:main:main"
    assert config.web_session_key() == "agent:main:web"
    assert config.web_session_prefix() == "agent:main:web"
    assert config.inbox_triage_session_key() == "agent:main:inbox-triage"


def test_memory_extract_session_follows_agent_id(iso):
    """The memory-extraction utility thread must follow the agent id too
    (parity for 'main', correct for others) — caught in final review."""
    from backend import memory
    iso.setattr(config, "_openclaw_json", lambda: {"agents": {"list": [{"id": "main"}]}})
    assert memory._extract_session() == "agent:main:web-memex"
    iso.setattr(config, "_openclaw_json", lambda: {"agents": {"list": [{"id": "scout"}]}})
    assert memory._extract_session() == "agent:scout:web-memex"
