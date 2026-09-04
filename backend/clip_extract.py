"""Extraction: turn a clip_fetch.Fetched response into readable markdown
(the third stage of backend/clip.py's pipeline).

trafilatura is optional at IMPORT time: backend/requirements.txt pins it,
but an operator who has not yet re-run `pip install -r
backend/requirements.txt` must not have the whole clip route (or this
module's import) crash: it degrades to a tag-stripped-text fallback and
marks itself as such (extractor="fallback") so callers/tests can tell."""
from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import attachments

try:
    import trafilatura
except ImportError:  # pragma: no cover - exercised via the fallback tests
    trafilatura = None


class ExtractFailed(Exception):
    """Nothing usable came out: an empty text/plain or text/markdown body,
    or a PDF with no extractable text."""


@dataclass
class Extracted:
    title: str
    markdown: str
    byline: str | None
    site_name: str | None
    extractor: str  # "trafilatura" | "fallback" | "passthrough" | "pdf"


_TAG_RE = re.compile(r"<[^>]+>")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_HEAD_RE = re.compile(r"(?is)<head[^>]*>.*?</head>")
_SCRIPT_STYLE_RE = re.compile(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>")
_WS_RE = re.compile(r"[ \t]+")
_BLANKLINES_RE = re.compile(r"\n{3,}")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


def _html_title(html: str) -> str | None:
    m = _TITLE_RE.search(html)
    if not m:
        return None
    text = _TAG_RE.sub("", m.group(1)).strip()
    return text or None


def _fallback_markdown(html: str) -> str:
    """Tag-stripped plain text, used when trafilatura is unavailable or
    returns nothing. Not real markdown, just readable text, but keeps the
    clip usable instead of failing the whole request over a missing
    dependency or a page trafilatura's readability heuristic gives up on.
    <head> (title/meta/script/style) is dropped first so its text never
    leaks into the body."""
    text = _HEAD_RE.sub(" ", html)
    text = _SCRIPT_STYLE_RE.sub(" ", text)
    text = _TAG_RE.sub("\n", text)
    text = _WS_RE.sub(" ", text)
    text = _BLANKLINES_RE.sub("\n\n", text)
    lines = [ln.strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln).strip()


def _title_fallback(meta_title: str | None, html: str | None, url: str) -> str:
    if meta_title and meta_title.strip():
        return meta_title.strip()
    if html:
        t = _html_title(html)
        if t:
            return t
    return url


def _split_trafilatura_frontmatter(text: str) -> tuple[dict, str]:
    """trafilatura's markdown output, with_metadata=True, prepends a flat
    YAML-ish frontmatter block (title/author/sitename/date/...). Split it
    into ({field: value}, remaining markdown body). No PyYAML dependency
    (matches vault_store.py's own no-PyYAML rule, backend/vault_store.py:10-14)
    -- the frontmatter is flat `key: value` lines, so a line-level split
    is enough."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip().lower()] = value.strip().strip('"')
    return meta, m.group(2).lstrip("\n")


def extract(fetched, url: str) -> Extracted:
    """Extract `fetched` into readable markdown. `url` is the ORIGINAL
    (pre-redirect, clip_guard-normalized) clip URL, used as the
    last-resort title only when neither the extractor's metadata nor an
    HTML <title> tag has one. Raises ExtractFailed when nothing usable
    comes out."""
    ctype = fetched.content_type

    if ctype in ("text/plain", "text/markdown"):
        text = fetched.body.decode("utf-8", errors="replace").strip()
        if not text:
            raise ExtractFailed(f"empty {ctype} body")
        return Extracted(title=_title_fallback(None, None, url), markdown=text,
                         byline=None, site_name=None, extractor="passthrough")

    if ctype == "application/pdf":
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        try:
            tmp.write(fetched.body)
            tmp.close()
            text = attachments._extract_file_text(Path(tmp.name), "application/pdf")
        finally:
            Path(tmp.name).unlink(missing_ok=True)
        if not text or not text.strip():
            raise ExtractFailed("pypdf found no extractable text in the PDF")
        return Extracted(title=_title_fallback(None, None, url), markdown=text.strip(),
                         byline=None, site_name=None, extractor="pdf")

    # text/html, application/xhtml+xml
    html = fetched.body.decode("utf-8", errors="replace")
    if trafilatura is not None:
        raw = trafilatura.extract(
            html, output_format="markdown", include_links=True,
            include_tables=True, with_metadata=True, url=fetched.final_url,
        )
        if raw and raw.strip():
            meta, body = _split_trafilatura_frontmatter(raw)
            markdown = body.strip()
            if markdown:
                return Extracted(
                    title=_title_fallback(meta.get("title"), html, url),
                    markdown=markdown,
                    byline=meta.get("author") or None,
                    site_name=meta.get("sitename") or meta.get("hostname") or None,
                    extractor="trafilatura",
                )
    # Fallback: trafilatura missing, or it returned nothing usable.
    markdown = _fallback_markdown(html)
    if not markdown:
        raise ExtractFailed("no readable text found in the page")
    return Extracted(title=_title_fallback(None, html, url), markdown=markdown,
                     byline=None, site_name=None, extractor="fallback")
