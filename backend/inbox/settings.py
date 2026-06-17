"""Inbox collector configuration.

Reads `.data/inbox.json` (beside connection.json / branding.json in DATA_DIR)
and merges it over safe defaults. All public accessors follow the pattern:
    env var  >  inbox.json  >  default

IMPORTANT — backward-compat default:
    When `.data/inbox.json` is absent (the common case for existing installs),
    EVERY collector is enabled. This ensures that a maintainer's live deployment
    is unaffected by upgrading to this version: no seed file is needed, and no
    inbox items disappear on deploy.

    To turn off a collector you don't use, add `.data/inbox.json`:
    {
      "collectors": {
        "slack":  { "enabled": false },
        "asana":  { "enabled": false }
      }
    }

    See README for the full schema and per-collector env-var overrides.

Asana special rule:
    asana is considered enabled only when BOTH its project_gid is non-empty AND
    its PAT file exists on disk. This prevents errors on a generic install where
    asana credentials were never configured — even if "enabled": true is set, a
    missing GID or missing PAT file silently disables the collector.

`.data/inbox.json` schema (all keys optional):
{
  "collectors": {
    "gmail":    { "enabled": true, "internal_domain": "example.com" },
    "slack":    { "enabled": true, "domain": "example.slack.com" },
    "asana":    { "enabled": true, "project_gid": "",
                  "pat_path": "~/.openclaw/workspace/secrets/asana.env" },
    "obsidian": { "enabled": true,
                  "vault": "~/.openclaw/workspace/Meetings",
                  "window_days": 120 }
  }
}
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .. import config as _cfg

# Where inbox.json lives — same DATA_DIR as connection.json / branding.json.
# Resolved at call time (not module import) so tests can monkeypatch config.DATA_DIR.
def _inbox_json_path() -> Path:
    return _cfg.DATA_DIR / "inbox.json"


def _load_raw() -> dict:
    """Read .data/inbox.json (best-effort). Never raises."""
    try:
        return json.loads(_inbox_json_path().read_text())
    except (FileNotFoundError, ValueError):
        return {}


def inbox_config() -> dict:
    """Return the merged inbox config (inbox.json over defaults). Never raises.

    Callers should use the per-accessor functions below rather than this dict
    directly; the dict schema is an implementation detail.
    """
    return _load_raw()


def _collectors(cfg: dict) -> dict:
    return (cfg.get("collectors") or {})


def _coll(name: str) -> dict:
    return _collectors(inbox_config()).get(name) or {}


# ---------------------------------------------------------------------------
# Gmail
# ---------------------------------------------------------------------------

def gmail_enabled() -> bool:
    """Gmail collector on/off. Env INBOX_GMAIL_ENABLED > inbox.json > True."""
    env = os.environ.get("INBOX_GMAIL_ENABLED")
    if env is not None:
        return env.lower() not in ("0", "false", "no", "off")
    val = _coll("gmail").get("enabled")
    return val if val is not None else True   # default ON


def gmail_internal_domain() -> str:
    """Internal email domain for scoring. Env > inbox.json > 'example.com'."""
    return (os.environ.get("INBOX_INTERNAL_DOMAIN")
            or _coll("gmail").get("internal_domain")
            or "example.com")


# ---------------------------------------------------------------------------
# Slack
# ---------------------------------------------------------------------------

def slack_enabled() -> bool:
    """Slack collector on/off. Env INBOX_SLACK_ENABLED > inbox.json > True."""
    env = os.environ.get("INBOX_SLACK_ENABLED")
    if env is not None:
        return env.lower() not in ("0", "false", "no", "off")
    val = _coll("slack").get("enabled")
    return val if val is not None else True   # default ON


def slack_domain() -> str:
    """Slack workspace domain. Env SLACK_DOMAIN > inbox.json > 'example.slack.com'."""
    return (os.environ.get("SLACK_DOMAIN")
            or _coll("slack").get("domain")
            or "example.slack.com")


# ---------------------------------------------------------------------------
# Asana
# ---------------------------------------------------------------------------

def asana_enabled() -> bool:
    """Asana collector on/off flag. Env INBOX_ASANA_ENABLED > inbox.json > True.
    NOTE: even when True the collector only runs if asana_project_gid() is
    non-empty AND asana_pat_path() exists — see enabled_collectors()."""
    env = os.environ.get("INBOX_ASANA_ENABLED")
    if env is not None:
        return env.lower() not in ("0", "false", "no", "off")
    val = _coll("asana").get("enabled")
    return val if val is not None else True   # default ON


def asana_project_gid() -> str:
    """Asana project GID. Env ASANA_PROJECT_GID > inbox.json > ''.

    Empty string is the generic default — a user without asana configured
    gets no GID and therefore asana is implicitly disabled.
    """
    return (os.environ.get("ASANA_PROJECT_GID")
            or _coll("asana").get("project_gid")
            or "")


def asana_pat_path() -> Path:
    """Resolved path to the asana.env PAT file.
    Env INBOX_ASANA_ENV > inbox.json pat_path > ~/.openclaw/workspace/secrets/asana.env.
    """
    raw = (os.environ.get("INBOX_ASANA_ENV")
           or _coll("asana").get("pat_path")
           or str(_cfg.OPENCLAW_HOME / "workspace/secrets/asana.env"))
    return Path(raw).expanduser()


# ---------------------------------------------------------------------------
# Obsidian
# ---------------------------------------------------------------------------

def obsidian_enabled() -> bool:
    """Obsidian collector on/off. Env INBOX_OBSIDIAN_ENABLED > inbox.json > True."""
    env = os.environ.get("INBOX_OBSIDIAN_ENABLED")
    if env is not None:
        return env.lower() not in ("0", "false", "no", "off")
    val = _coll("obsidian").get("enabled")
    return val if val is not None else True   # default ON


def obsidian_vault() -> Path:
    """Obsidian meetings vault directory.
    Env INBOX_MEETINGS_DIR > inbox.json vault > ~/.openclaw/workspace/Meetings.
    """
    raw = (os.environ.get("INBOX_MEETINGS_DIR")
           or _coll("obsidian").get("vault")
           or str(Path.home() / ".openclaw/workspace/Meetings"))
    return Path(raw).expanduser()


def obsidian_window_days() -> int:
    """Lookback window for meeting notes. Env OBSIDIAN_WINDOW_DAYS > inbox.json > 120."""
    env = os.environ.get("OBSIDIAN_WINDOW_DAYS")
    if env is not None:
        try:
            return int(env)
        except ValueError:
            pass
    val = _coll("obsidian").get("window_days")
    if val is not None:
        try:
            return int(val)
        except (ValueError, TypeError):
            pass
    return 120


# ---------------------------------------------------------------------------
# Documents (account-free — always enabled when inbox is on)
# ---------------------------------------------------------------------------

def documents_enabled() -> bool:
    """Documents-stale collector. Env INBOX_DOCUMENTS_ENABLED > inbox.json > True.
    Account-free: no external service required.
    """
    env = os.environ.get("INBOX_DOCUMENTS_ENABLED")
    if env is not None:
        return env.lower() not in ("0", "false", "no", "off")
    val = _coll("documents").get("enabled")
    return val if val is not None else True   # default ON


# ---------------------------------------------------------------------------
# Enabled collector list
# ---------------------------------------------------------------------------

def enabled_collectors() -> list[str]:
    """Return SOURCES keys whose collector is both enabled AND configured.

    Ordering matches the canonical SOURCES dict order:
        gmail, slack, asana, obsidian, documents

    Asana requires BOTH a non-empty project_gid AND the PAT file on disk;
    if either is missing the collector is silently excluded regardless of the
    enabled flag — so a generic user without asana config never errors.
    """
    out: list[str] = []
    if gmail_enabled():
        out.append("gmail")
    if slack_enabled():
        out.append("slack")
    # Asana: enabled flag + non-empty GID + PAT file present
    if asana_enabled() and asana_project_gid() and asana_pat_path().exists():
        out.append("asana")
    if obsidian_enabled():
        out.append("obsidian")
    if documents_enabled():
        out.append("documents")
    return out
