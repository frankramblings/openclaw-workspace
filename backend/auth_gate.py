"""Optional pure-ASGI auth gate for OpenClaw Workspace.

Completely inactive unless WORKSPACE_AUTH_TOKEN or a session secret
(WORKSPACE_AUTH_SECRET / SHARE_SECRET) is set.  The live-deploy
maintainer sets neither → every request is passed straight through to the app
with the original (scope, receive, send), so there is ZERO wrapping of the
response stream.  This matters: the chat endpoint is a long-lived SSE
StreamingResponse, and wrapping it (as Starlette's BaseHTTPMiddleware does, via
a task group + disconnect listener) is exactly the fragile path we avoid here.

When the gate IS active every request must authenticate via EITHER a token:
  - Authorization: Bearer <token>
  - X-Workspace-Token: <token>
  - ?token=<token>   query parameter
  - workspace_auth   cookie
OR a valid session cookie (default name `share_session`) minted by a
password/passkey login wall on the SAME origin — e.g. the media-share wall — so
a public deploy can sit behind Face ID / password instead of a bare token URL.
Unauthenticated browser navigations are 302'd to WORKSPACE_AUTH_LOGIN_URL (with
a ?next= back-link) when set; API and WebSocket requests get 401 / handshake
close.

WebSockets are gated too (the terminal shell at /api/terminal/.../stream is a
WebSocket — leaving it open would mean the token protects everything EXCEPT the
most dangerous endpoint). Browsers can't set custom headers on a WS handshake,
but they DO send the workspace_auth cookie (from a prior HTTP ?token= auth) and
can pass ?token= on the socket URL, so real clients authenticate the same way.

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

import base64
import hashlib
import hmac
import time
from urllib.parse import parse_qs, quote

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


def _valid_session(cookie_val: str, secret: bytes, max_age: int) -> bool:
    """Validate a `payload.sig` session cookie minted by a same-origin login
    wall (HMAC-SHA256 over a unix-timestamp payload). Mirrors the media share's
    _issue_session/_valid_session so ONE login covers both surfaces."""
    try:
        b64, sig = cookie_val.split(".", 1)
        payload = base64.urlsafe_b64decode(b64.encode())
        expected = hmac.new(secret, payload, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return False
        issued = int(payload.decode())
        return (time.time() - issued) < max_age
    except Exception:
        return False


def _session_ok(scope) -> bool:
    """True if the request carries a valid shared-session cookie."""
    secret = config.auth_session_secret()
    if not secret:
        return False
    headers = {k.decode("latin-1").lower(): v.decode("latin-1")
               for k, v in scope.get("headers", [])}
    val = _parse_cookies(headers.get("cookie", "")).get(config.auth_session_cookie(), "")
    return bool(val) and _valid_session(val, secret, config.auth_session_max_age())


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
    """Pure-ASGI gate. Rejects unauthenticated HTTP requests AND WebSocket
    handshakes when WORKSPACE_AUTH_TOKEN is set; otherwise a transparent
    passthrough.

    Reads the token at request-time (not construction) so tests can monkeypatch
    config.auth_token between cases without rebuilding the app.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        stype = scope["type"]
        if stype not in ("http", "websocket"):          # lifespan etc. — untouched
            return await self.app(scope, receive, send)

        if not config.auth_active():                    # no-op: untouched passthrough
            return await self.app(scope, receive, send)

        if scope.get("path", "") in _ALLOWLIST:
            return await self.app(scope, receive, send)

        token = config.auth_token()
        provided, from_query = _credential(scope)
        token_ok = bool(token and provided and _token_matches(provided, token))
        # Accept EITHER the bearer token OR a valid same-origin login-wall session
        # cookie (password/passkey). The latter is how a public deploy sits behind
        # a Face-ID/password wall instead of a bare token URL.
        if not (token_ok or _session_ok(scope)):
            if stype == "websocket":
                await _reject_ws(receive, send)         # decline handshake → 403
            else:
                await _unauth_http(scope, send)
            return

        # Authenticated. A WebSocket handshake can't carry a Set-Cookie the way
        # an HTTP response can, so just forward it — the browser already holds
        # the workspace_auth cookie (or passed ?token= on the socket URL). Only
        # a fresh ?token= HTTP auth mints the convenience cookie; session-cookie
        # auth needs nothing set.
        if stype == "websocket" or not (from_query and token_ok):
            return await self.app(scope, receive, send)

        # Authenticated via ?token= → set the cookie by rewriting ONLY the
        # response start headers; the body stream passes through untouched.
        # Secure is appended when the request arrived over HTTPS, directly or
        # via Tailscale Serve's X-Forwarded-Proto — the app itself is served
        # plain-HTTP on loopback; Serve terminates TLS in front of it.
        hdrs = dict(scope.get("headers", []))
        https = (scope.get("scheme") == "https"
                 or hdrs.get(b"x-forwarded-proto", b"").decode() == "https")
        cookie = (f"{_COOKIE_NAME}={provided}; HttpOnly; SameSite=Lax; "
                  f"Path=/; Max-Age={_COOKIE_MAX_AGE}" + ("; Secure" if https else ""))

        async def send_with_cookie(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"set-cookie", cookie.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        return await self.app(scope, receive, send_with_cookie)


async def _reject_ws(receive, send) -> None:
    """Decline a WebSocket handshake carrying a missing/invalid token. Consume
    the guaranteed-first `websocket.connect` event, then close BEFORE accept —
    uvicorn turns a pre-accept close into an HTTP 403, so the socket (e.g. the
    terminal shell) never opens. 1008 = policy violation."""
    await receive()
    await send({"type": "websocket.close", "code": 1008})


async def _unauth_http(scope, send) -> None:
    """Unauthenticated HTTP request. Send a browser navigation to the login wall
    (302 with a ?next= back-link) when one is configured; everything else — API
    calls, sub-resources, non-GET — gets a plain 401 so clients fail cleanly."""
    login = config.auth_login_url()
    headers = {k.decode("latin-1").lower(): v.decode("latin-1")
               for k, v in scope.get("headers", [])}
    accept = headers.get("accept", "")
    if login and scope.get("method", "GET") == "GET" and "text/html" in accept:
        base = config.BASE_PATH or ""
        qs = scope.get("query_string", b"").decode("latin-1")
        nxt = base + scope.get("path", "/") + (f"?{qs}" if qs else "")
        sep = "&" if "?" in login else "?"
        location = f"{login}{sep}next={quote(nxt, safe='/')}"
        await send({
            "type": "http.response.start",
            "status": 302,
            "headers": [(b"location", location.encode("latin-1")),
                        (b"content-length", b"0"),
                        (b"cache-control", b"no-store")],
        })
        await send({"type": "http.response.body", "body": b""})
        return
    await _send_401(send)


async def _send_401(send) -> None:
    body = b'{"error": "authentication required"}'
    await send({
        "type": "http.response.start",
        "status": 401,
        "headers": [(b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})
