"""URL clip: POST /api/clip fetches a URL, extracts readable markdown, and
files it as a Library document (backend/documents.py) with source_*
provenance so re-clipping the same URL updates the document in place
(open decision 7) instead of piling up duplicates.

Three stages, each its own module so a change to fetch safety never
touches extraction logic and vice versa: clip_guard (SSRF policy),
clip_fetch (the HTTP fetch itself), clip_extract (HTML/PDF/text ->
markdown)."""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import clip_extract, clip_fetch, clip_guard, config, documents
from . import vault_store as vs

log = logging.getLogger(__name__)

router = APIRouter()

# Open decision 12 (confirm or change these two caps).
_DEFAULT_MAX_BYTES = 5 * 1024 * 1024
_DEFAULT_TIMEOUT_S = 15.0

_WS_RE = re.compile(r"\s+")


def _caps() -> tuple[int, float]:
    """(max_bytes, timeout_s), read fresh from the environment on every
    call rather than cached as import-time module constants. Fix round 1:
    the caps used to be plain module globals (MAX_BYTES/TIMEOUT_S) set once
    at import; a test that wanted to exercise the env override had to
    importlib.reload(clip) to re-run that assignment, which mutated this
    module's globals for the REST of the pytest session (every later test
    silently inherited whatever env vars the reload test happened to set).
    Reading through config._env_int/_env_float on every call instead means
    a test can monkeypatch os.environ per-test with zero cross-test state
    -- monkeypatch's own teardown handles the reset, nothing here needs to
    remember or restore anything."""
    return (config._env_int("WORKSPACE_CLIP_MAX_BYTES", _DEFAULT_MAX_BYTES),
            config._env_float("WORKSPACE_CLIP_TIMEOUT_S", _DEFAULT_TIMEOUT_S))


def _err(status: int, error: str, detail: str) -> JSONResponse:
    return JSONResponse({"ok": False, "error": error, "detail": detail}, status_code=status)


def _blocked_url_response(exc: clip_guard.BlockedUrl) -> JSONResponse:
    """Map a clip_guard.BlockedUrl's reason to this route's error envelope.
    Used for BOTH the initial check_url call and any BlockedUrl clip_fetch
    raises mid-fetch (a redirect target re-validated through the same
    guard). dns_failed (a hostname that simply did not resolve, e.g. a
    typo'd domain) is NOT an SSRF block: it is mapped to fetch_failed/502
    like any other unreachable-URL case, not blocked_host/400 -- a
    resolution failure carries no signal that the URL was trying to reach
    a private address."""
    if exc.reason == "bad_url":
        return _err(400, "bad_url", exc.detail)
    if exc.reason == "dns_failed":
        return _err(502, "fetch_failed", exc.detail)
    return _err(400, "blocked_host", exc.detail)


def _find_existing(source_url: str) -> dict | None:
    """The Library document, if any, previously clipped from this exact
    (clip_guard-normalized) source_url. Archived docs are excluded -- an
    archived clip of the same URL is left alone and a fresh one is
    created, matching how every other list route in documents.py treats
    archived docs as out of the active set.

    Match is EXACT string equality on the normalized URL, by design: a
    trailing-slash variant ("https://x.com/a" vs "https://x.com/a/") or a
    "www." vs bare-host variant of the same page is a different
    source_url and therefore creates a SECOND document rather than
    updating the first. clip_guard.check_url normalizes scheme/host case,
    a trailing root-label dot, and the default port, but does not
    canonicalize path trailing slashes or strip "www." -- neither is safe
    to assume equivalent in general (a site can serve different content at
    the trailing-slash / www variant), so this is a conservative default,
    not an oversight."""
    for d in documents._scan_docs():
        if d.get("source_url") == source_url and not d.get("archived"):
            return d
    return None


def _clean_title(title: str) -> str:
    """Title hygiene: the extractor hands back the raw page <title> (or a
    user-supplied override) as-is -- it can contain newlines/tabs, runs of
    internal whitespace, and 500+ characters (some pages stuff breadcrumbs
    or the whole nav into <title>). Collapse all whitespace (including
    newlines/tabs) to single spaces, strip, and cap at 200 chars before
    this is used as BOTH the document's own title and the '# {title}' H1 --
    a raw multi-line/oversized title would otherwise corrupt the H1 line
    and make the Library list row unreadable. This is distinct from
    _mention_safe_title below, which additionally forbids ']' so the
    mention TOKEN stays parseable by the @mention grammar; the document's
    own title is not required to avoid ']'."""
    t = _WS_RE.sub(" ", title or "").strip()
    t = t[:200].strip()
    return t or "Untitled"


def _mention_safe_title(title: str) -> str:
    """Title text as it appears inside the @[Title](doc:id) mention token
    (spec section 1.2's MENTION_RE: no ']', no newline, <=200 chars). The
    document's OWN title (doc['title']) is already whitespace-collapsed
    and capped by _clean_title -- this additionally strips ']' since the
    token has to stay parseable by Pillar C1's mention grammar even when a
    page title contains one."""
    t = _clean_title(title).replace("]", ")")
    return t or "Untitled"


def _h1_safe_title(title: str) -> str:
    """`title` as it appears on the '# {title}' H1 line specifically (NOT
    doc['title'], which is left as _clean_title produced it -- that field
    is displayed as plain text, never rendered as markdown, so it needs no
    escaping). Two markdown-syntax hazards a raw page title can carry that
    the H1 LINE must neutralize: a leading '#' would compound with the
    literal '# ' prefix into an unintended deeper heading (e.g. a title of
    "# Breaking" would render as "## Breaking"), and an unescaped
    '[text](...)'-shaped pair reads as a markdown link -- backslash-
    escaping '[' and ']' (rather than replacing them, which would lose
    the original characters) prevents that regardless of what follows."""
    t = title
    if t.startswith("#"):
        t = "\\" + t
    return t.replace("[", "\\[").replace("]", "\\]")


def _build_body(title: str, final_url: str, clipped_date: str, markdown: str) -> str:
    return f"# {_h1_safe_title(title)}\n\nSource: {final_url}\nClipped: {clipped_date}\n\n{markdown}"


@router.post("/api/clip")
async def clip_url(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - malformed JSON body
        return _err(400, "bad_url", "request body must be JSON")
    # Fix round 1, Critical 1: a JSON body that parses but isn't an object
    # (a bare list/string/number/null) has no .get, so every read below
    # used to raise AttributeError -- an unhandled 500. A non-string
    # title/session_id (e.g. {"title": 123}) used to raise the same way at
    # .strip(). All three are now explicit 400s naming the problem field,
    # never a bare crash.
    if not isinstance(body, dict):
        return _err(400, "bad_request", "request body must be a JSON object")
    raw_url = body.get("url")
    title_raw = body.get("title")
    if title_raw is not None and not isinstance(title_raw, str):
        return _err(400, "bad_request", "title must be a string")
    title_override = (title_raw or "").strip()
    session_id_raw = body.get("session_id")
    if session_id_raw is not None and not isinstance(session_id_raw, str):
        return _err(400, "bad_request", "session_id must be a string")
    session_id = session_id_raw or ""

    try:
        normalized = clip_guard.check_url(raw_url)
    except clip_guard.BlockedUrl as exc:
        return _blocked_url_response(exc)

    max_bytes, timeout_s = _caps()
    try:
        fetched = await clip_fetch.fetch(normalized, max_bytes=max_bytes, timeout_s=timeout_s)
    except clip_guard.BlockedUrl as exc:
        return _blocked_url_response(exc)
    except clip_fetch.TooLarge as exc:
        return _err(413, "too_large", str(exc))
    except clip_fetch.UnsupportedType as exc:
        return _err(415, "unsupported_type", str(exc))
    except clip_fetch.FetchFailed as exc:
        return _err(502, "fetch_failed", str(exc))
    except Exception as exc:  # noqa: BLE001 - Fix round 1, Critical 2 belt-and-braces:
        # clip_guard.check_url now rejects control chars/embedded whitespace
        # up front (the durable fix), so httpx should never again be handed
        # a URL shape it can't parse -- but the fetch layer talks to a real
        # HTTP client and an unanticipated failure there must still never
        # surface as a bare, unmapped 500. Exception TEXT is never put in
        # the envelope (it can carry arbitrary internal detail); only the
        # exception's type name is logged.
        log.error("clip fetch raised an unexpected %s for %s",
                  type(exc).__name__, normalized, exc_info=True)
        return _err(502, "fetch_failed", "fetch failed")

    try:
        extracted = await asyncio.to_thread(clip_extract.extract, fetched, normalized)
    except clip_extract.ExtractFailed as exc:
        return _err(422, "extract_failed", str(exc))

    title = _clean_title(title_override or extracted.title)
    now = vs.now_iso()
    clipped_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    content = _build_body(title, fetched.final_url, clipped_date, extracted.markdown)

    existing = await asyncio.to_thread(_find_existing, normalized)
    try:
        if existing is not None:
            err = documents._safe_snapshot(existing)
            if err is not None:
                return _err(500, "write_failed", "could not snapshot the existing document")
            existing.update({
                "title": title, "current_content": content,
                "source_url": normalized, "source_final_url": fetched.final_url,
                "source_site": extracted.site_name or "", "source_byline": extracted.byline or "",
                "clipped_at": now, "version_count": existing.get("version_count", 1) + 1,
                "updated_at": now,
            })
            doc = documents._write(existing)
        else:
            doc = documents._write({
                "id": vs.new_id(), "title": title, "language": "markdown",
                "session_id": session_id, "session_name": "",
                "current_content": content, "version_count": 1,
                "is_active": True, "archived": False,
                "created": now, "updated_at": now,
                "source_url": normalized, "source_final_url": fetched.final_url,
                "source_site": extracted.site_name or "", "source_byline": extracted.byline or "",
                "clipped_at": now,
            })
    except Exception:  # noqa: BLE001 - matches documents.py's own _safe_write pattern
        log.error("clip write failed for %s", normalized, exc_info=True)
        return _err(500, "write_failed", "could not save the clipped document")

    mention = f"@[{_mention_safe_title(title)}](doc:{doc['id']})"
    meta = {
        "source_url": normalized, "final_url": fetched.final_url,
        "site_name": extracted.site_name, "byline": extracted.byline,
        "fetched_at": now, "content_type": fetched.content_type,
        "bytes": len(fetched.body), "extractor": extracted.extractor,
        "redirects": fetched.redirects,
    }
    return {"ok": True, "document": doc, "mention": mention, "meta": meta}
