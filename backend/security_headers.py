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
import secrets

_STATIC = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
]

_CSP_HEAD = b"default-src 'self'; img-src 'self' data: blob:; " \
            b"style-src 'self' 'unsafe-inline'; script-src 'self'"
_CSP_TAIL = b"; connect-src 'self' ws: wss:; worker-src 'self'; " \
            b"frame-ancestors 'none'"

SCOPE_KEY = "csp_nonce"


def request_nonce(scope) -> str:
    """The per-request CSP nonce this middleware minted, or "" if the request
    did not pass through it (unit tests calling a handler directly). Route
    handlers read it through `request.state.csp_nonce`; Starlette's
    `HTTPConnection.state` is a live view over `scope["state"]`, which is where
    the middleware stores it."""
    return (scope.get("state") or {}).get(SCOPE_KEY, "")


def build_policy(nonce: str) -> bytes:
    """The policy string, with the request's nonce added to script-src.

    Only script-src gets it. `'unsafe-inline'` is deliberately NOT added:
    a nonce and 'unsafe-inline' together mean browsers that understand the
    nonce ignore 'unsafe-inline' but older ones do not, so it would be a
    silent downgrade rather than a fallback."""
    src = _CSP_HEAD
    if nonce:
        src += b" 'nonce-" + nonce.encode("ascii") + b"'"
    return src + _CSP_TAIL


class SecurityHeadersMiddleware:
    """Pure-ASGI wrapper — appends security headers to every HTTP response
    START message. No config beyond WORKSPACE_CSP_ENFORCE. Registered
    OUTERMOST in app.py so it also covers AuthGateMiddleware's 401/403/302
    responses, not just responses that reach the router.

    It also mints one CSP nonce per request, publishes it on the ASGI scope
    (`scope["state"]["csp_nonce"]`, i.e. `request.state.csp_nonce`) and adds it
    to script-src. `_spa_html()` stamps that value on the two scripts it has to
    inject inline under WORKSPACE_BASE_PATH (the import map and the network
    shim), which is what lets a base-path tenant enforce the policy at all. The
    nonce is minted on EVERY request, not only the ones that inject: it costs a
    single `secrets.token_urlsafe(16)` and keeps the header uniform, and a nonce
    nothing references grants nothing."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        enforce = os.environ.get("WORKSPACE_CSP_ENFORCE") == "1"
        nonce = secrets.token_urlsafe(16)
        scope.setdefault("state", {})[SCOPE_KEY] = nonce
        policy = build_policy(nonce)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.extend(_STATIC)
                key = (b"content-security-policy" if enforce
                       else b"content-security-policy-report-only")
                headers.append((key, policy))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)
