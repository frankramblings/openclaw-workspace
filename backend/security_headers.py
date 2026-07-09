"""Security response headers on every HTTP response.

CSP starts Report-Only so a policy mistake can't brick the installed PWA;
set WORKSPACE_CSP_ENFORCE=1 after a clean soak.

The enforce flag is read per-request rather than cached at __init__: Starlette
builds and caches its ASGI middleware stack lazily on the FIRST request the
`app` singleton ever receives (Starlette.__call__ checks
`if self.middleware_stack is None`), so by the time any given test runs some
earlier test has usually already triggered that build. Reading os.environ at
call-time mirrors AuthGateMiddleware's own precedent (see auth_gate.py's
docstring: "Reads the token at request-time (not construction) so tests can
monkeypatch... between cases without rebuilding the app") and keeps
WORKSPACE_CSP_ENFORCE monkeypatchable per test case.
"""
import os

_STATIC = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
]

_CSP = (b"default-src 'self'; img-src 'self' data: blob:; "
        b"style-src 'self' 'unsafe-inline'; script-src 'self'; "
        b"connect-src 'self' ws: wss:; worker-src 'self'; "
        b"frame-ancestors 'none'")


class SecurityHeadersMiddleware:
    """Pure-ASGI wrapper — appends security headers to every HTTP response
    START message. No config beyond WORKSPACE_CSP_ENFORCE. Registered
    OUTERMOST in app.py so it also covers AuthGateMiddleware's 401/403/302
    responses, not just responses that reach the router."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        enforce = os.environ.get("WORKSPACE_CSP_ENFORCE") == "1"

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(_STATIC)
                key = (b"content-security-policy" if enforce
                       else b"content-security-policy-report-only")
                headers.append((key, _CSP))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)
