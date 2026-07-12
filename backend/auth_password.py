"""POST /api/auth/change-password — real credential verification + rotation.

This deployment is single-user with no accounts of its own (see app.py's
"Auth stubs" comment on /api/auth/status: "single-user/no-auth deployment
behind Tailscale"). The one real password concept anywhere in this codebase
is the OpenClaw gateway's own `gateway.auth.password` — read at runtime via
config.gateway_password() from ~/.openclaw/openclaw.json, presented on every
gateway RPC connect (bridge.py), and already surfaced to the SPA as the
boolean `has_password` on /api/auth/status. Settings -> Account -> Change
Password is that value: this route verifies the CURRENT one (constant-time
compare — the same primitive auth_gate.py's own token check uses) then
rewrites just that one field in openclaw.json, atomically, leaving every
other key untouched. "hash the same way it stores": the value is stored in
plaintext (openclaw.json is itself a root-owned-directory secret, not
committed anywhere), so verification is a plaintext constant-time compare —
there is no separate hash to reproduce.

Caveat this route cannot paper over: gateway.auth.password is read by the
OpenClaw gateway DAEMON too — a separate long-running process from this web
backend. Writing a new value here updates what THIS process's bridge.py
presents on its next connect (the config.gateway_password() lru_cache is
busted below, so this process sees it immediately), but the gateway daemon
itself keeps expecting the OLD password until it reloads/restarts — the same
"mode flips, needs a gateway restart" gotcha already known from the onboard
wizard (see repo memory). This route deliberately does not restart anything;
callers should expect gateway reconnects to need a manual restart afterward.
"""
from __future__ import annotations

import hmac
import json
import logging
import os

from fastapi import APIRouter, Body, HTTPException

from . import config
from .fsutil import atomic_write_text, file_lock

log = logging.getLogger(__name__)

router = APIRouter()

MIN_LENGTH = 8


def _eq(a: str, b: str) -> bool:
    """Constant-time string compare (mirrors auth_gate._token_matches)."""
    return hmac.compare_digest(a.encode(), b.encode())


@router.post("/api/auth/change-password")
async def change_password(payload: dict = Body(default=None)):
    payload = payload or {}
    current = str(payload.get("current_password") or "")
    new = str(payload.get("new_password") or "")

    if os.environ.get("OPENCLAW_GATEWAY_PASSWORD"):
        # gateway_password() always prefers the env var over openclaw.json, so
        # a write here would be silently ineffective — say so instead of
        # pretending it worked.
        raise HTTPException(
            status_code=400,
            detail="Password is set via the OPENCLAW_GATEWAY_PASSWORD "
                   "environment variable and can't be changed here.")

    stored = config.gateway_password()
    if not stored:
        raise HTTPException(
            status_code=400,
            detail="No password is configured for this deployment.")
    if not current or not _eq(current, stored):
        raise HTTPException(status_code=400, detail="current password is wrong")
    if len(new) < MIN_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"New password must be at least {MIN_LENGTH} characters.")
    if _eq(new, stored):
        raise HTTPException(
            status_code=400,
            detail="New password must be different from the current password.")

    try:
        raw = json.loads(config.OPENCLAW_CONFIG.read_text())
    except (OSError, ValueError) as exc:
        log.error("change-password: could not read %s (%s)", config.OPENCLAW_CONFIG, exc)
        raise HTTPException(
            status_code=500, detail="Could not read the gateway config.") from exc

    gateway = raw.setdefault("gateway", {})
    if not isinstance(gateway, dict):
        gateway = raw["gateway"] = {}
    auth = gateway.setdefault("auth", {})
    if not isinstance(auth, dict):
        auth = gateway["auth"] = {}
    auth["password"] = new

    with file_lock(config.OPENCLAW_CONFIG):
        atomic_write_text(config.OPENCLAW_CONFIG,
                          json.dumps(raw, ensure_ascii=False, indent=2) + "\n")
    config._openclaw_json.cache_clear()  # this process sees the new value immediately

    log.warning("gateway auth password changed via /api/auth/change-password "
                "— the running openclaw gateway daemon must reload/restart to "
                "accept it")
    return {"ok": True}
