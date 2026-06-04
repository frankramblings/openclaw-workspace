"""Google OAuth bearer-token helper, reusing the google-calendar-mcp credentials.

Read-only on the creds: client keys from ~/.gmail-mcp/gcp-oauth.keys.json, refresh
token from ~/.config/google-calendar-mcp/tokens.json (the MCP's store stays the
source of truth — re-auth via the MCP and we pick it up). Refreshes + caches an
access token in memory until ~60s before it expires. Reusable for any Google API.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import httpx

_KEYS = Path(os.environ.get("GOOGLE_OAUTH_KEYS",
             Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"))
_TOKENS = Path(os.environ.get("GOOGLE_CAL_TOKENS",
               Path.home() / ".config" / "google-calendar-mcp" / "tokens.json"))
_TOKEN_URL = "https://oauth2.googleapis.com/token"

_CACHE: dict = {"token": None, "exp": 0.0}


def _creds() -> tuple[str, str, str]:
    keys = json.loads(_KEYS.read_text())
    inst = keys.get("installed") or keys.get("web") or {}
    tok = json.loads(_TOKENS.read_text())
    acct = tok.get("normal") or next(iter(tok.values()))
    return inst["client_id"], inst["client_secret"], acct["refresh_token"]


def _fetch_token() -> tuple[str, float]:
    cid, secret, refresh = _creds()
    with httpx.Client(timeout=25) as c:
        r = c.post(_TOKEN_URL, data={
            "client_id": cid, "client_secret": secret,
            "refresh_token": refresh, "grant_type": "refresh_token"})
    r.raise_for_status()
    d = r.json()
    return d["access_token"], time.time() + int(d.get("expires_in", 3600))


def access_token() -> str:
    if _CACHE["token"] and time.time() < _CACHE["exp"] - 60:
        return _CACHE["token"]
    tok, exp = _fetch_token()
    _CACHE["token"], _CACHE["exp"] = tok, exp
    return tok
