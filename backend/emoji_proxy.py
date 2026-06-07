"""Same-origin OpenMoji-black proxy for chat emoji glyphs.

markdown.js replaces every Unicode emoji in rendered chat with a CSS-mask
`<span>` pointing at `/api/emoji/<codepoints>.svg` (monochrome line glyph
tinted to the text color — the "never colorful emoji" rule). Upstream Odysseus
served these; here the `[]` catch-all answered them, the mask failed to load,
and emoji silently vanished from replies.

This proxies the OpenMoji *black* SVG set from jsDelivr and caches each glyph
on disk (immutable per pinned version), so after first fetch the glyph serves
offline. Unknown/unfetchable codes get a transparent 72×72 SVG — the mask
shows nothing, which is upstream's own miss behavior (invisible, not broken).

Filename rule: the frontend computes Twemoji-style codes (hex, `-`-joined,
FE0F stripped unless the sequence has a ZWJ) — probed 2026-06-07 to be
identical to OpenMoji's naming (`2764` ✓ / `2764-FE0F` ✗, but
`2764-FE0F-200D-1F525` ✓). `candidates()` still tries FE0F variants for
stragglers.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import httpx
from fastapi import APIRouter
from fastapi.responses import Response

from . import config

router = APIRouter()

CACHE_DIR = Path(os.environ.get("WORKSPACE_EMOJI_CACHE",
                                str(config.DATA_DIR / "emoji-cache")))

OPENMOJI_CDN = os.environ.get(
    "OPENMOJI_CDN", "https://cdn.jsdelivr.net/npm/openmoji@15.1.0/black/svg")

# OpenMoji glyphs are 72×72; an empty one renders nothing through the CSS mask.
TRANSPARENT = b'<svg id="emoji" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"/>'

# 1–16 hex codepoints joined by '-' (frontend emits unpadded lowercase hex).
_CODE_RE = re.compile(r"^[0-9a-fA-F]{2,6}(?:-[0-9a-fA-F]{2,6}){0,15}$")
ZWJ, VS16 = "200D", "FE0F"

_misses: set[str] = set()   # known-404 codes (in-memory; cheap to rebuild)
_client: httpx.AsyncClient | None = None


def canon(code: str) -> str | None:
    """Validate a codepoint path ('1f600', '2764-200d-1f525') → uppercase, or None.

    The strict charset doubles as path-traversal protection for the cache file.
    """
    if not _CODE_RE.match(code or ""):
        return None
    return code.upper()


def candidates(code: str) -> list[str]:
    """CDN filenames to try, most likely first (input: canonical uppercase).

    The code usually hits as-is (frontend rule == OpenMoji rule); the variants
    cover stragglers: FE0F stripped entirely, and FE0F inserted after the base
    emoji of a ZWJ sequence.
    """
    parts = code.split("-")
    out = [code, "-".join(p for p in parts if p != VS16)]
    if ZWJ in parts and parts[1:2] != [VS16]:
        out.append("-".join([parts[0], VS16] + parts[1:]))
    seen: set[str] = set()
    return [c for c in out if c and not (c in seen or seen.add(c))]


def _transparent() -> Response:
    # Short max-age: a transient network failure shouldn't blank a glyph for long.
    return Response(TRANSPARENT, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=3600"})


def _glyph(body: bytes) -> Response:
    return Response(body, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/api/emoji/{code}.svg")
async def emoji_svg(code: str):
    canonical = canon(code)
    if canonical is None or canonical in _misses:
        return _transparent()

    cached = CACHE_DIR / f"{canonical}.svg"
    if cached.is_file():
        return _glyph(cached.read_bytes())

    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=8.0, follow_redirects=True)
    for name in candidates(canonical):
        try:
            r = await _client.get(f"{OPENMOJI_CDN}/{name}.svg")
        except httpx.HTTPError:
            return _transparent()   # network trouble: fail invisibly, no miss recorded
        if r.status_code == 200 and 0 < len(r.content) < 262144:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(r.content)   # cache under the REQUESTED name
            return _glyph(r.content)
    _misses.add(canonical)
    return _transparent()
