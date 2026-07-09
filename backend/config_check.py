"""Startup config validation (Task 15).

The backend reads ~50 env vars with zero validation before this. A typo like
`WORKSPACE_STALL_CAP=24o` (finger slip on the zero) or a hand-edited
`~/.openclaw/openclaw.json` with a trailing comma used to surface as an
unhandled crash wherever the bad value was first read/used — sometimes at
process start, sometimes deep inside a chat turn, always with a traceback
that doesn't say "check your env vars." run() below is a single pre-serve
pass, called from app.py's lifespan startup (before the app accepts
requests), that catches the common cases and turns them into short,
actionable strings the caller logs with `log.warning`.

Only ONE condition here is fatal (raises instead of returning a string):
`.data/` being unwritable. Every other check is advisory — a misconfigured
env var should degrade to that setting's built-in default, not take the
whole app down, so this module never raises for those.

Numeric env vars are handled in TWO cooperating layers, sharing ONE parse
implementation (config.parse_env_number):
  1. Degrade at read time: every int()/float() env cast in the backend
     (config.py, research.py, backend/inbox/sources/*) goes through
     config._env_int/_env_float, which log a warning and fall back to the
     call site's default instead of raising. This matters because 9 of the
     11 numeric vars are cast as plain module-level assignments — i.e. at
     IMPORT time, before app.py even defines the FastAPI app — so a bare
     float(os.environ...) there used to kill the process with a raw
     ValueError during `import backend.app`, long before any startup check
     could run.
  2. Report at startup: _check_numeric_env below re-parses the same vars via
     the same config.parse_env_number and returns a problem string for each
     bad one, so the misconfiguration is also visible as an explicit
     "config check:" warning in the boot log (not just a one-line fallback
     notice buried at import time).
"""
from __future__ import annotations

import json
import logging
import os
import uuid

from . import config

log = logging.getLogger(__name__)

# Every backend/*.py call site that casts an env var to int()/float(), found
# by reading config.py (~:130-141, :43, :270), research.py, and
# backend/inbox/sources/*.py — all of them now routed through
# config._env_int/_env_float so a bad value degrades instead of crashing.
# (name, caster, the call site's own default — the default is what the app
# actually falls back to; run() skips unset vars entirely since an absent var
# just means "the call site's default applies," not a problem.)
NUMERIC_ENV_VARS: tuple[tuple[str, type, str], ...] = (
    ("OPENCLAW_GATEWAY_PORT", int, "18789"),          # config.gateway_port (lazy)
    ("WORKSPACE_TURN_TIMEOUT_S", float, "180"),        # config.py module-level
    ("WORKSPACE_STALL_NOTICE", float, "45"),           # config.py module-level
    ("WORKSPACE_STALL_CAP", float, "240"),             # config.py module-level
    ("SHARE_SESSION_DAYS", int, "30"),                 # config.auth_session_max_age (lazy)
    ("WORKSPACE_RESEARCH_TURN_TIMEOUT_S", float, "900"),   # research.py module-level
    ("INBOX_GMAIL_LIST", int, "50"),                   # inbox/sources/gmail.py module-level
    ("SLACK_STALE_MIN", int, str(24 * 60)),            # inbox/sources/slack.py module-level
    ("SLACK_THREAD_RECENT_HOURS", int, "4"),           # inbox/sources/slack.py module-level
    ("DOCS_STALE_DAYS", float, "4"),                   # inbox/sources/documents_stale.py module-level
    ("OBSIDIAN_WINDOW_DAYS", int, "120"),               # inbox/sources/obsidian.py module-level
)

# Every WORKSPACE_*/OPENCLAW_*/INBOX_* env var the backend actually reads,
# built by grepping backend/*.py (excluding tests/) for double-quoted
# "WORKSPACE_..."/"OPENCLAW_..."/"INBOX_..." string literals passed to
# os.environ.get / os.getenv / os.environ[]. Kept in sync by
# backend/tests/test_config_check.py::test_typo_allowlist_matches_grep_of_backend_source,
# which re-derives the same set from source and fails the suite if they drift.
#
# LIMITATION: this is a hand-maintained snapshot, not a runtime-derived list.
# It only catches vars whose name appears in source as a literal string —
# anything built dynamically (an f-string, a variable) is invisible to the
# grep AND to this check, so it can miss a real var and it can go stale when
# a new env var is added without updating this set (the regression test above
# catches the second case; nothing catches the first). It's scoped to these
# three prefixes rather than every env var the app reads, and is advisory
# only, for exactly this reason: a false "possible typo" on a real,
# less-common var is an acceptable cost at warn-only severity; a false
# negative on a genuine typo is the expected failure mode of a curated list
# and is why this is a *detector*, not a validator.
KNOWN_ENV_VARS: frozenset[str] = frozenset({
    "INBOX_ASANA_ENABLED",
    "INBOX_ASANA_ENV",
    "INBOX_CALENDAR_ENABLED",
    "INBOX_DOCUMENTS_ENABLED",
    "INBOX_ENTITIES_DIR",
    "INBOX_ENTITIES_ENABLED",
    "INBOX_GMAIL_ENABLED",
    "INBOX_GMAIL_LIST",
    "INBOX_INTERNAL_DOMAIN",
    "INBOX_MEETINGS_DIR",
    "INBOX_OBSIDIAN_ENABLED",
    "INBOX_OWNER_NAME",
    "INBOX_SLACK_CHANNELS",
    "INBOX_SLACK_ENABLED",
    "INBOX_SLACK_SIGNALS",
    "INBOX_SLACK_USERS",
    "OPENCLAW_AGENT_ID",
    "OPENCLAW_ATTACHED_TERMINAL",
    "OPENCLAW_BRANCH_CONTEXT_DIR",
    "OPENCLAW_DEFAULT_MODEL",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_WS",
    "OPENCLAW_HOME",
    "OPENCLAW_INBOX_TRIAGE_MODEL",
    "OPENCLAW_INBOX_TRIAGE_SESSION_KEY",
    "OPENCLAW_MCPORTER_CONFIG",
    "OPENCLAW_MEMORY_MD",
    "OPENCLAW_SESSION_KEY",
    "OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK",
    "OPENCLAW_TERMINAL_REQUIRE_TSHEADER",
    "OPENCLAW_WEB_SESSION_KEY",
    "OPENCLAW_WEB_SESSION_PREFIX",
    "WORKSPACE_ACCENT",
    "WORKSPACE_AGENT_NAME",
    "WORKSPACE_AUTH_LOGIN_URL",
    "WORKSPACE_AUTH_SECRET",
    "WORKSPACE_AUTH_SESSION_COOKIE",
    "WORKSPACE_AUTH_TOKEN",
    "WORKSPACE_BASE_PATH",
    "WORKSPACE_CHROME_BIN",
    "WORKSPACE_DATA_DIR",
    "WORKSPACE_EMAIL_ADDRESS",
    "WORKSPACE_EMOJI_CACHE",
    "WORKSPACE_FRONTEND_DIR",
    "WORKSPACE_LOG_LEVEL",
    "WORKSPACE_RESEARCH_TURN_TIMEOUT_S",
    "WORKSPACE_SOURCE_URL",
    "WORKSPACE_STALL_CAP",
    "WORKSPACE_STALL_NOTICE",
    "WORKSPACE_TITLE_MODEL",
    "WORKSPACE_TURN_TIMEOUT_S",
    "WORKSPACE_USER",
})

_TYPO_PREFIXES = ("WORKSPACE_", "OPENCLAW_", "INBOX_")


def _check_numeric_env(problems: list[str]) -> None:
    # Same parse as config._env_int/_env_float (config.parse_env_number is
    # the single source of truth), so this report can never disagree with
    # what the app actually did with the value.
    for name, caster, default in NUMERIC_ENV_VARS:
        _value, problem = config.parse_env_number(name, caster)
        if problem is not None:
            problems.append(
                f"{problem}; the app is using the default ({default}) instead")


def _check_openclaw_json(problems: list[str]) -> None:
    path = config.OPENCLAW_CONFIG
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return  # no gateway config yet -- normal on a fresh install
    except (OSError, UnicodeDecodeError) as exc:
        # UnicodeDecodeError is a ValueError, NOT an OSError: a non-UTF-8
        # openclaw.json must land here as a problem string, not escape and
        # turn this advisory check into a boot abort.
        problems.append(f"{path} could not be read ({exc.__class__.__name__}: {exc})")
        return
    try:
        json.loads(text)
    except json.JSONDecodeError as exc:
        problems.append(
            f"{path} is not valid JSON ({exc}); gateway settings will fall back to defaults"
        )


def _check_vault_root(problems: list[str]) -> None:
    vault = config.OPENCLAW_HOME / "workspace"
    if not vault.is_dir():
        problems.append(
            f"vault root {vault} does not exist; documents/notes/vault-backed features will fail"
        )


def _check_typos(problems: list[str]) -> None:
    for name in sorted(os.environ):
        if not name.startswith(_TYPO_PREFIXES):
            continue
        if name in KNOWN_ENV_VARS:
            continue
        problems.append(
            f"env {name} is set but is not a recognized WORKSPACE_/OPENCLAW_/INBOX_ "
            f"variable (possible typo?)"
        )


def _check_data_writable() -> None:
    """The one fatal check: raise if `.data/` can't be written to. Every
    store (sessions, inbox state, branding, connection) lives there, so an
    unwritable `.data/` means the app can boot but can never persist
    anything — better to fail loudly at startup than silently drop every
    write from then on."""
    data_dir = config.DATA_DIR
    probe = data_dir / f".config_check-{uuid.uuid4().hex}.tmp"
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        probe.write_text("ok")
        probe.unlink()
    except OSError as exc:
        raise RuntimeError(
            f"{data_dir} is not writable ({exc.__class__.__name__}: {exc}) -- "
            "the app cannot persist sessions/state and will not start"
        ) from exc


def run() -> list[str]:
    """Run every startup config check. Returns human-readable problem strings
    for the caller to log (one per issue found); raises RuntimeError only if
    `.data/` is unwritable, since that's the one condition the app cannot
    run without."""
    problems: list[str] = []
    _check_numeric_env(problems)
    _check_openclaw_json(problems)
    _check_vault_root(problems)
    _check_typos(problems)
    try:
        _check_data_writable()  # last: fatal, so run every advisory check first
    except Exception:
        # The caller never sees the returned list when we raise -- log the
        # advisory findings ourselves so they aren't silently dropped from
        # the crash report they might help explain.
        for problem in problems:
            log.warning("config check: %s", problem)
        raise
    return problems
