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


def test_session_key_env_override_wins(iso):
    iso.setenv("OPENCLAW_WEB_SESSION_KEY", "agent:custom:thing")
    assert config.web_session_key() == "agent:custom:thing"


def test_maintainer_parity(iso):
    """agent id 'main' => keys byte-identical to the v1 constants."""
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "main"}]}})
    assert config.session_key() == "agent:main:main"
    assert config.web_session_key() == "agent:main:web"
