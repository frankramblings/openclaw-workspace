"""Tests for backend.inbox.settings — config-driven collector selection.

Covers:
- Absent-file default: all four standard collectors enabled (backward-compat)
- Per-collector enabled flag: env > inbox.json > default (True)
- Per-collector value accessors: env > inbox.json > default
- enabled_collectors(): disable via inbox.json; asana GID/PAT rules
- items() integration: disabled collector not included in results
- capabilities._inbox(): reflects >= 1 enabled collector
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from backend.inbox import settings
from backend import capabilities as caps
from backend import config as _cfg


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_inbox_json(tmp_path: Path, data: dict) -> Path:
    """Write .data/inbox.json under tmp_path and return the path."""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    p = data_dir / "inbox.json"
    p.write_text(json.dumps(data))
    return p


# ---------------------------------------------------------------------------
# Backward-compat: absent file = all collectors on
# ---------------------------------------------------------------------------

class TestAbsentFileDefault:
    """With NO .data/inbox.json the set of enabled collectors must be
    gmail/slack/obsidian/documents (= legacy all-on behaviour).
    Asana is excluded because generic installs have no GID / PAT file.
    """

    def test_gmail_enabled_by_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("INBOX_GMAIL_ENABLED", raising=False)
        assert settings.gmail_enabled() is True

    def test_slack_enabled_by_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("INBOX_SLACK_ENABLED", raising=False)
        assert settings.slack_enabled() is True

    def test_obsidian_enabled_by_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("INBOX_OBSIDIAN_ENABLED", raising=False)
        assert settings.obsidian_enabled() is True

    def test_documents_enabled_by_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("INBOX_DOCUMENTS_ENABLED", raising=False)
        assert settings.documents_enabled() is True

    def test_asana_flag_on_by_default_but_gid_missing(self, tmp_path, monkeypatch):
        """Asana flag defaults True but generic install has no GID → not in list."""
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("INBOX_ASANA_ENABLED", raising=False)
        monkeypatch.delenv("ASANA_PROJECT_GID", raising=False)
        assert settings.asana_enabled() is True        # flag is on
        assert settings.asana_project_gid() == ""      # but no GID

    def test_enabled_collectors_absent_file_includes_gmail_slack_obsidian_documents(
            self, tmp_path, monkeypatch):
        """The key backward-compat assertion: no inbox.json → all four
        non-asana collectors are enabled (asana excluded because GID empty)."""
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        # Clear all override env vars
        for var in ("INBOX_GMAIL_ENABLED", "INBOX_SLACK_ENABLED",
                    "INBOX_ASANA_ENABLED", "INBOX_OBSIDIAN_ENABLED",
                    "INBOX_DOCUMENTS_ENABLED", "ASANA_PROJECT_GID",
                    "INBOX_ASANA_ENV"):
            monkeypatch.delenv(var, raising=False)
        result = settings.enabled_collectors()
        assert "gmail" in result
        assert "slack" in result
        assert "obsidian" in result
        assert "documents" in result
        # Asana excluded: no GID
        assert "asana" not in result


# ---------------------------------------------------------------------------
# Per-collector enabled flag: env > inbox.json > default
# ---------------------------------------------------------------------------

class TestEnabledFlagPrecedence:

    def test_env_overrides_json_gmail(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"gmail": {"enabled": True}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.setenv("INBOX_GMAIL_ENABLED", "false")
        assert settings.gmail_enabled() is False

    def test_json_overrides_default_gmail(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"gmail": {"enabled": False}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("INBOX_GMAIL_ENABLED", raising=False)
        assert settings.gmail_enabled() is False

    def test_env_overrides_json_slack(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"slack": {"enabled": True}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.setenv("INBOX_SLACK_ENABLED", "0")
        assert settings.slack_enabled() is False

    def test_json_overrides_default_slack(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"slack": {"enabled": False}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("INBOX_SLACK_ENABLED", raising=False)
        assert settings.slack_enabled() is False

    def test_env_overrides_json_asana(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"asana": {"enabled": True}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.setenv("INBOX_ASANA_ENABLED", "no")
        assert settings.asana_enabled() is False

    def test_json_overrides_default_asana(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"asana": {"enabled": False}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("INBOX_ASANA_ENABLED", raising=False)
        assert settings.asana_enabled() is False

    def test_env_overrides_json_obsidian(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"obsidian": {"enabled": True}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.setenv("INBOX_OBSIDIAN_ENABLED", "off")
        assert settings.obsidian_enabled() is False

    def test_json_overrides_default_obsidian(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"obsidian": {"enabled": False}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("INBOX_OBSIDIAN_ENABLED", raising=False)
        assert settings.obsidian_enabled() is False

    def test_env_overrides_json_documents(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"documents": {"enabled": True}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.setenv("INBOX_DOCUMENTS_ENABLED", "false")
        assert settings.documents_enabled() is False

    def test_json_overrides_default_documents(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"documents": {"enabled": False}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("INBOX_DOCUMENTS_ENABLED", raising=False)
        assert settings.documents_enabled() is False


# ---------------------------------------------------------------------------
# Per-collector value accessors: env > inbox.json > default
# ---------------------------------------------------------------------------

class TestValueAccessors:

    def test_gmail_internal_domain_env(self, monkeypatch):
        monkeypatch.setenv("INBOX_INTERNAL_DOMAIN", "corp.example.com")
        assert settings.gmail_internal_domain() == "corp.example.com"

    def test_gmail_internal_domain_json(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {
            "gmail": {"internal_domain": "acme.org"}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("INBOX_INTERNAL_DOMAIN", raising=False)
        assert settings.gmail_internal_domain() == "acme.org"

    def test_gmail_internal_domain_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("INBOX_INTERNAL_DOMAIN", raising=False)
        assert settings.gmail_internal_domain() == "example.com"

    def test_slack_domain_env(self, monkeypatch):
        monkeypatch.setenv("SLACK_DOMAIN", "myco.slack.com")
        assert settings.slack_domain() == "myco.slack.com"

    def test_slack_domain_json(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {
            "slack": {"domain": "acme.slack.com"}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("SLACK_DOMAIN", raising=False)
        assert settings.slack_domain() == "acme.slack.com"

    def test_slack_domain_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("SLACK_DOMAIN", raising=False)
        assert settings.slack_domain() == "example.slack.com"

    def test_asana_project_gid_env(self, monkeypatch):
        monkeypatch.setenv("ASANA_PROJECT_GID", "9999888877776666")
        assert settings.asana_project_gid() == "9999888877776666"

    def test_asana_project_gid_json(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {
            "asana": {"project_gid": "1234567890123456"}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("ASANA_PROJECT_GID", raising=False)
        assert settings.asana_project_gid() == "1234567890123456"

    def test_asana_project_gid_default_is_empty(self, tmp_path, monkeypatch):
        """Generic default must be empty — no maintainer-specific GID."""
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("ASANA_PROJECT_GID", raising=False)
        assert settings.asana_project_gid() == ""

    def test_obsidian_vault_env(self, tmp_path, monkeypatch):
        meetings = tmp_path / "Meetings"
        meetings.mkdir()
        monkeypatch.setenv("INBOX_MEETINGS_DIR", str(meetings))
        assert settings.obsidian_vault() == meetings

    def test_obsidian_vault_json(self, tmp_path, monkeypatch):
        meetings = tmp_path / "MyMeetings"
        meetings.mkdir()
        _write_inbox_json(tmp_path, {"collectors": {
            "obsidian": {"vault": str(meetings)}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("INBOX_MEETINGS_DIR", raising=False)
        assert settings.obsidian_vault() == meetings

    def test_obsidian_window_days_env(self, monkeypatch):
        monkeypatch.setenv("OBSIDIAN_WINDOW_DAYS", "60")
        assert settings.obsidian_window_days() == 60

    def test_obsidian_window_days_json(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {
            "obsidian": {"window_days": 30}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("OBSIDIAN_WINDOW_DAYS", raising=False)
        assert settings.obsidian_window_days() == 30

    def test_obsidian_window_days_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("OBSIDIAN_WINDOW_DAYS", raising=False)
        assert settings.obsidian_window_days() == 120


# ---------------------------------------------------------------------------
# enabled_collectors() logic
# ---------------------------------------------------------------------------

class TestEnabledCollectors:

    def test_disable_slack_via_json(self, tmp_path, monkeypatch):
        _write_inbox_json(tmp_path, {"collectors": {"slack": {"enabled": False}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        for var in ("INBOX_GMAIL_ENABLED", "INBOX_SLACK_ENABLED",
                    "INBOX_ASANA_ENABLED", "INBOX_OBSIDIAN_ENABLED",
                    "INBOX_DOCUMENTS_ENABLED", "ASANA_PROJECT_GID"):
            monkeypatch.delenv(var, raising=False)
        result = settings.enabled_collectors()
        assert "slack" not in result
        assert "gmail" in result
        assert "obsidian" in result
        assert "documents" in result

    def test_asana_excluded_when_gid_empty(self, tmp_path, monkeypatch):
        """Empty project_gid → asana not in enabled list even with enabled=True."""
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.delenv("ASANA_PROJECT_GID", raising=False)
        monkeypatch.delenv("INBOX_ASANA_ENABLED", raising=False)
        result = settings.enabled_collectors()
        assert "asana" not in result

    def test_asana_excluded_when_pat_file_missing(self, tmp_path, monkeypatch):
        """Non-empty GID but PAT file absent → asana not in list."""
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.setenv("ASANA_PROJECT_GID", "1234567890123456")
        monkeypatch.delenv("INBOX_ASANA_ENABLED", raising=False)
        # Point pat_path to a file that doesn't exist
        monkeypatch.setenv("INBOX_ASANA_ENV", str(tmp_path / "asana.env"))
        result = settings.enabled_collectors()
        assert "asana" not in result

    def test_asana_included_when_gid_and_pat_present(self, tmp_path, monkeypatch):
        """GID set + PAT file exists → asana in enabled list."""
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.setenv("ASANA_PROJECT_GID", "1234567890123456")
        monkeypatch.delenv("INBOX_ASANA_ENABLED", raising=False)
        pat_file = tmp_path / "asana.env"
        pat_file.write_text('ASANA_PAT="fake-token"\n')
        monkeypatch.setenv("INBOX_ASANA_ENV", str(pat_file))
        result = settings.enabled_collectors()
        assert "asana" in result

    def test_asana_excluded_when_flag_off(self, tmp_path, monkeypatch):
        """enabled=False in inbox.json overrides GID+PAT presence."""
        _write_inbox_json(tmp_path, {"collectors": {"asana": {"enabled": False}}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "data")
        monkeypatch.delenv("INBOX_ASANA_ENABLED", raising=False)
        pat_file = tmp_path / "asana.env"
        pat_file.write_text('ASANA_PAT="fake-token"\n')
        monkeypatch.setenv("ASANA_PROJECT_GID", "1234567890123456")
        monkeypatch.setenv("INBOX_ASANA_ENV", str(pat_file))
        result = settings.enabled_collectors()
        assert "asana" not in result

    def test_all_disabled_returns_empty_list(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.setenv("INBOX_GMAIL_ENABLED", "false")
        monkeypatch.setenv("INBOX_SLACK_ENABLED", "false")
        monkeypatch.setenv("INBOX_ASANA_ENABLED", "false")
        monkeypatch.setenv("INBOX_OBSIDIAN_ENABLED", "false")
        monkeypatch.setenv("INBOX_DOCUMENTS_ENABLED", "false")
        monkeypatch.setenv("INBOX_CALENDAR_ENABLED", "false")
        monkeypatch.setenv("INBOX_ENTITIES_ENABLED", "false")
        assert settings.enabled_collectors() == []

    def test_order_is_stable(self, tmp_path, monkeypatch):
        """Returned list must preserve canonical order when all enabled."""
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        for var in ("INBOX_GMAIL_ENABLED", "INBOX_SLACK_ENABLED",
                    "INBOX_ASANA_ENABLED", "INBOX_OBSIDIAN_ENABLED",
                    "INBOX_DOCUMENTS_ENABLED", "INBOX_CALENDAR_ENABLED"):
            monkeypatch.delenv(var, raising=False)
        pat_file = tmp_path / "asana.env"
        pat_file.write_text('ASANA_PAT="fake-token"\n')
        monkeypatch.setenv("ASANA_PROJECT_GID", "1234567890123456")
        monkeypatch.setenv("INBOX_ASANA_ENV", str(pat_file))
        result = settings.enabled_collectors()
        assert result.index("gmail") < result.index("slack")
        assert result.index("slack") < result.index("asana")
        assert result.index("asana") < result.index("obsidian")
        assert result.index("obsidian") < result.index("documents")
        assert result.index("documents") < result.index("calendar")


# ---------------------------------------------------------------------------
# items() integration: disabled collector not in results
# ---------------------------------------------------------------------------

class TestItemsIntegration:
    """items() must only run collectors in enabled_collectors()."""

    @pytest.fixture
    def anyio_backend(self):
        return "asyncio"

    @pytest.mark.anyio
    async def test_disabled_collector_not_called(self, tmp_path, monkeypatch):
        """When slack is disabled via inbox.json, its fetch should not be called."""
        import backend.inbox as inbox
        from backend.inbox import state

        monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
        state._mem = None
        inbox._cache.clear()

        called = []

        async def fake_gmail():
            called.append("gmail")
            return []

        async def fake_slack():
            called.append("slack")
            return []

        async def fake_asana():
            called.append("asana")
            return []

        async def fake_obsidian():
            called.append("obsidian")
            return []

        async def fake_documents():
            called.append("documents")
            return []

        monkeypatch.setitem(inbox.SOURCES, "gmail", fake_gmail)
        monkeypatch.setitem(inbox.SOURCES, "slack", fake_slack)
        monkeypatch.setitem(inbox.SOURCES, "asana", fake_asana)
        monkeypatch.setitem(inbox.SOURCES, "obsidian", fake_obsidian)
        monkeypatch.setitem(inbox.SOURCES, "documents", fake_documents)

        # Disable slack via env
        monkeypatch.setenv("INBOX_SLACK_ENABLED", "false")
        # Ensure asana is also excluded (no GID)
        monkeypatch.delenv("ASANA_PROJECT_GID", raising=False)
        # Other collectors enabled
        for v in ("INBOX_GMAIL_ENABLED", "INBOX_ASANA_ENABLED",
                  "INBOX_OBSIDIAN_ENABLED", "INBOX_DOCUMENTS_ENABLED"):
            monkeypatch.delenv(v, raising=False)
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")

        await inbox.items()

        assert "slack" not in called
        assert "gmail" in called

    @pytest.mark.anyio
    async def test_sources_param_still_constrained_by_enabled(
            self, tmp_path, monkeypatch):
        """?sources=slack should not run slack if it's disabled."""
        import backend.inbox as inbox
        from backend.inbox import state

        monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
        state._mem = None
        inbox._cache.clear()

        slack_called = []

        async def fake_slack():
            slack_called.append(True)
            return []

        monkeypatch.setitem(inbox.SOURCES, "slack", fake_slack)
        monkeypatch.setenv("INBOX_SLACK_ENABLED", "false")
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")

        result = await inbox.items(sources="slack")
        assert slack_called == []
        assert result["sources"] == {}


# ---------------------------------------------------------------------------
# capabilities._inbox() with enabled_collectors check
# ---------------------------------------------------------------------------

class TestCapabilitiesInbox:

    def test_inbox_unavailable_when_not_enabled(self, monkeypatch):
        monkeypatch.setattr(caps.config, "load_connection", lambda: {})
        result = caps.snapshot()
        assert result["inbox"]["available"] is False
        assert "enable" in result["inbox"]["hint"]

    def test_inbox_unavailable_when_no_collectors_enabled(
            self, tmp_path, monkeypatch):
        monkeypatch.setattr(caps.config, "load_connection",
                            lambda: {"integrations": {"inbox": True}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        monkeypatch.setenv("INBOX_GMAIL_ENABLED", "false")
        monkeypatch.setenv("INBOX_SLACK_ENABLED", "false")
        monkeypatch.setenv("INBOX_ASANA_ENABLED", "false")
        monkeypatch.setenv("INBOX_OBSIDIAN_ENABLED", "false")
        monkeypatch.setenv("INBOX_DOCUMENTS_ENABLED", "false")
        monkeypatch.setenv("INBOX_CALENDAR_ENABLED", "false")
        monkeypatch.setenv("INBOX_ENTITIES_ENABLED", "false")
        result = caps.snapshot()
        assert result["inbox"]["available"] is False
        assert "collector" in result["inbox"]["reason"]

    def test_inbox_available_when_enabled_and_has_collectors(
            self, tmp_path, monkeypatch):
        monkeypatch.setattr(caps.config, "load_connection",
                            lambda: {"integrations": {"inbox": True}})
        monkeypatch.setattr(_cfg, "DATA_DIR", tmp_path / "nodata")
        # At least gmail is on (default)
        for v in ("INBOX_GMAIL_ENABLED", "INBOX_SLACK_ENABLED",
                  "INBOX_OBSIDIAN_ENABLED", "INBOX_DOCUMENTS_ENABLED"):
            monkeypatch.delenv(v, raising=False)
        monkeypatch.delenv("ASANA_PROJECT_GID", raising=False)
        result = caps.snapshot()
        assert result["inbox"]["available"] is True


# ---------------------------------------------------------------------------
# asana_section_gid(): env > inbox.json > default
# ---------------------------------------------------------------------------

def test_asana_section_gid_default(monkeypatch):
    monkeypatch.delenv("ASANA_SECTION_GID", raising=False)
    monkeypatch.setattr(settings, "_coll", lambda name: {})
    assert settings.asana_section_gid() == "1206274018380402"


def test_asana_section_gid_env_wins(monkeypatch):
    monkeypatch.setenv("ASANA_SECTION_GID", "ENVSEC")
    assert settings.asana_section_gid() == "ENVSEC"


def test_asana_section_gid_from_inbox_json(monkeypatch):
    monkeypatch.delenv("ASANA_SECTION_GID", raising=False)
    monkeypatch.setattr(settings, "_coll", lambda name: {"section_gid": "JSONSEC"})
    assert settings.asana_section_gid() == "JSONSEC"


def test_entities_in_enabled_collectors(monkeypatch):
    from backend.inbox import settings
    monkeypatch.setattr(settings, "entities_enabled", lambda: True)
    assert "entities" in settings.enabled_collectors()
