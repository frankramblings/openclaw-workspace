"""Optional pure-ASGI auth gate for OpenClaw Workspace.

Completely inactive unless WORKSPACE_AUTH_TOKEN is set.  The live-deploy
maintainer sets no token → every request is passed straight through to the app
with the original (scope, receive, send), so there is ZERO wrapping of the
response stream.  This matters: the chat endpoint is a long-lived SSE
StreamingResponse, and wrapping it (as Starlette's BaseHTTPMiddleware does, via
a task group + disconnect listener) is exactly the fragile path we avoid here.

When a token IS configured every request must present it via:
  - Authorization: Bearer <token>
  - X-Workspace-Token: <token>
  - ?token=<token>   query parameter
  - workspace_auth   cookie

Allowlist (always open, even with a token configured):
  /api/health              — container health check
  /api/followup/register   — bin/followup wrapper (enforces its own token,
  /api/followup/complete     see backend/followup.py _authorized)

Browser convenience: a successful ?token= auth sets the workspace_auth cookie
(HttpOnly, SameSite=Lax) on the response so later requests work without it. The
cookie is added by rewriting only the response START message's headers — the
body stream is never touched, so SSE keeps flushing incrementally.
"""
from __future__ import annotations

import hmac
from urllib.parse import parse_qs

from . import config

# Paths that bypass the auth gate regardless of token config.
# The followup wrapper endpoints enforce their own bearer token in
# backend/followup.py (_authorized) — see followup_token().
_ALLOWLIST: frozenset[str] = frozenset({
    "/api/health",
    "/api/followup/register",
    "/api/followup/complete",
})

_COOKIE_NAME = "workspace_auth"
_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _token_matches(provided: str, expected: str) -> bool:
    """Constant-time comparison to prevent timing side-channels."""
    return hmac.compare_digest(provided.encode(), expected.encode())


def _parse_cookies(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in raw.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _credential(scope) -> tuple[str | None, bool]:
    """Pull the token from headers / cookie / query. Returns (token, from_query)."""
    headers = {k.decode("latin-1").lower(): v.decode("latin-1")
               for k, v in scope.get("headers", [])}

    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        tok = auth[7:].strip()
        if tok:
            return tok, False

    xtok = headers.get("x-workspace-token", "").strip()
    if xtok:
        return xtok, False

    cookie = _parse_cookies(headers.get("cookie", "")).get(_COOKIE_NAME, "").strip()
    if cookie:
        return cookie, False

    qs = parse_qs(scope.get("query_string", b"").decode("latin-1"))
    qtok = (qs.get("token") or [""])[0].strip()
    if qtok:
        return qtok, True

    return None, False


class AuthGateMiddleware:
    """Pure-ASGI gate. Rejects unauthenticated HTTP requests when
    WORKSPACE_AUTH_TOKEN is set; otherwise a transparent passthrough.

    Reads the token at request-time (not construction) so tests can monkeypatch
    config.auth_token between cases without rebuilding the app.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        token = config.auth_token()
        if not token:                                   # no-op: untouched passthrough
            return await self.app(scope, receive, send)

        if scope.get("path", "") in _ALLOWLIST:
            return await self.app(scope, receive, send)

        provided, from_query = _credential(scope)
        if not provided or not _token_matches(provided, token):
            await _send_401(send)
            return

        if not from_query:
            return await self.app(scope, receive, send)

        # Authenticated via ?token= → set the cookie by rewriting ONLY the
        # response start headers; the body stream passes through untouched.
        cookie = (f"{_COOKIE_NAME}={provided}; HttpOnly; SameSite=Lax; "
                  f"Path=/; Max-Age={_COOKIE_MAX_AGE}")

        async def send_with_cookie(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"set-cookie", cookie.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        return await self.app(scope, receive, send_with_cookie)


async def _send_401(send) -> None:
    body = b'{"error": "authentication required"}'
    await send({
        "type": "http.response.start",
        "status": 401,
        "headers": [(b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})
