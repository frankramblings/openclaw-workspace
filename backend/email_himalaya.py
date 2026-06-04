"""The Odysseus Email tab, backed by a real himalaya Gmail mailbox.

Replaces the triage-feed adapter that used to live on /api/email/* in inbox.py.
Maps himalaya's CLI output ⇄ the exact shapes emailInbox.js / emailLibrary.js /
document.js expect. Pure functions (mappers, MIME builder) are unit-tested; the
I/O paths are verified live against the mailbox.
"""
from __future__ import annotations

import os
import tomllib
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from . import himalaya_cli  # noqa: F401  (used by later tasks)

router = APIRouter()

_HIMALAYA_CONFIG = Path(os.environ.get(
    "HIMALAYA_CONFIG", Path.home() / ".config" / "himalaya" / "config.toml"))


def _account_address() -> str:
    """The configured Gmail address (for the accounts list + From header).
    Read from the himalaya config so there's a single source of truth."""
    env = os.environ.get("WORKSPACE_EMAIL_ADDRESS")
    if env:
        return env
    try:
        cfg = tomllib.loads(_HIMALAYA_CONFIG.read_text())
        for acct in (cfg.get("accounts") or {}).values():
            if acct.get("default") and acct.get("email"):
                return acct["email"]
        # fall back to the first account with an email
        for acct in (cfg.get("accounts") or {}).values():
            if acct.get("email"):
                return acct["email"]
    except Exception:  # noqa: BLE001
        pass
    return ""


ACCOUNT_ADDRESS = _account_address()


@router.get("/api/email/accounts")
async def accounts():
    addr = ACCOUNT_ADDRESS
    return [{"account_id": "gmail", "address": addr, "name": addr, "default": True}]
