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
MAX_BYTES = config._env_int("WORKSPACE_CLIP_MAX_BYTES", 5 * 1024 * 1024)
TIMEOUT_S = config._env_float("WORKSPACE_CLIP_TIMEOUT_S", 15.0)

_WS_RE = re.compile(r"\s+")


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
    archived docs as out of the active set."""
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


def _build_body(title: str, final_url: str, clipped_date: str, markdown: str) -> str:
    return f"# {title}\n\nSource: {final_url}\nClipped: {clipped_date}\n\n{markdown}"


@router.post("/api/clip")
async def clip_url(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - malformed JSON body
        return _err(400, "bad_url", "request body must be JSON")
    raw_url = (body or {}).get("url")
    title_override = ((body or {}).get("title") or "").strip()
    session_id = (body or {}).get("session_id") or ""

    try:
        normalized = clip_guard.check_url(raw_url)
    except clip_guard.BlockedUrl as exc:
        return _blocked_url_response(exc)

    try:
        fetched = await clip_fetch.fetch(normalized, max_bytes=MAX_BYTES, timeout_s=TIMEOUT_S)
    except clip_guard.BlockedUrl as exc:
        return _blocked_url_response(exc)
    except clip_fetch.TooLarge as exc:
        return _err(413, "too_large", str(exc))
    except clip_fetch.UnsupportedType as exc:
        return _err(415, "unsupported_type", str(exc))
    except clip_fetch.FetchFailed as exc:
        return _err(502, "fetch_failed", str(exc))

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
