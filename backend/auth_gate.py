"""Optional ASGI/Starlette auth gate for OpenClaw Workspace.

Completely inactive unless WORKSPACE_AUTH_TOKEN is set.  The live-deploy
maintainer sets no token → this module is imported but the middleware is
never added to the app and has zero runtime effect.

When a token IS configured every request must present it via:
  - Authorization: Bearer <token>
  - X-Workspace-Token: <token>
  - ?token=<token>   query parameter
  - workspace_auth   cookie

Allowlist (always open, even with a token configured):
  /api/health    — container health check

Browser convenience: a successful ?token= auth sets the workspace_auth cookie
(HttpOnly, SameSite=Lax) on the response so later requests work without it.
"""
from __future__ import annotations

import hmac

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from . import config

# Paths that bypass the auth gate regardless of token config.
_ALLOWLIST: frozenset[str] = frozenset({"/api/health"})

_COOKIE_NAME = "workspace_auth"
_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _token_matches(provided: str, expected: str) -> bool:
    """Constant-time comparison to prevent timing side-channels."""
    return hmac.compare_digest(provided.encode(), expected.encode())


class AuthGateMiddleware(BaseHTTPMiddleware):
    """Reject unauthenticated requests when WORKSPACE_AUTH_TOKEN is set.

    Reads the token at request-time (not class instantiation) so tests can
    monkeypatch config.auth_token between cases without app restarts.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        token = config.auth_token()

        # No token configured → complete no-op.
        if not token:
            return await call_next(request)

        # Allowlisted path → always pass through.
        if request.url.path in _ALLOWLIST:
            return await call_next(request)

        # --- Extract credential from whichever source is present -------------
        provided: str | None = None
        set_cookie = False  # did we receive via ?token=? (triggers cookie set)

        # 1. Authorization: Bearer
        auth_header = request.headers.get("authorization", "")
        if auth_header.lower().startswith("bearer "):
            provided = auth_header[7:].strip()

        # 2. X-Workspace-Token header
        if not provided:
            provided = request.headers.get("x-workspace-token", "").strip() or None

        # 3. Cookie
        if not provided:
            provided = request.cookies.get(_COOKIE_NAME, "").strip() or None

        # 4. ?token= query param (sets cookie on success)
        if not provided:
            qtoken = request.query_params.get("token", "").strip()
            if qtoken:
                provided = qtoken
                set_cookie = True

        if not provided or not _token_matches(provided, token):
            return JSONResponse(
                status_code=401,
                content={"error": "authentication required"},
            )

        response = await call_next(request)

        if set_cookie:
            response.set_cookie(
                _COOKIE_NAME,
                provided,
                httponly=True,
                samesite="lax",
                max_age=_COOKIE_MAX_AGE,
            )

        return response
