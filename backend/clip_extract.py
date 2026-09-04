"""Extraction: turn a clip_fetch.Fetched response into readable markdown
(the third stage of backend/clip.py's pipeline).

trafilatura is optional at IMPORT time: backend/requirements.txt pins it,
but an operator who has not yet re-run `pip install -r
backend/requirements.txt` must not have the whole clip route (or this
module's import) crash: it degrades to a tag-stripped-text fallback and
marks itself as such (extractor="fallback") so callers/tests can tell.
The SAME fallback is used if trafilatura is present but raises (an
unexpected page shape, a bug inside trafilatura) or returns nothing
usable -- extraction must never turn into a 500 just because the
best-effort HTML reader gave up."""
from __future__ import annotations

import codecs
import html
import logging
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import attachments

try:
    import trafilatura
except ImportError:  # pragma: no cover - exercised via the fallback tests
    trafilatura = None

log = logging.getLogger(__name__)


class ExtractFailed(Exception):
    """Nothing usable came out: an empty text/plain or text/markdown body,
    a PDF with no extractable text, or an HTML page (via trafilatura or
    the fallback) with no readable content. `reason` is a short
    machine-stable string (empty_body, pdf_no_text, no_text) that
    backend/clip.py (Task 4) can map onto an HTTP error code without
    parsing prose -- same shape as clip_fetch.FetchFailed. `detail` is
    additional diagnostic text for logging."""

    def __init__(self, reason: str, message: str = "", *, detail: str = ""):
        super().__init__(message or reason)
        self.reason = reason
        self.detail = detail or message or reason


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
# Block-level tags become a line break in the fallback text; everything
# else (b/i/a/span/em/strong/code, ...) is an inline tag and is stripped
# with no separator so a sentence wrapped in one stays on one line.
_BLOCK_TAGS = ("p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6",
               "li", "tr", "blockquote", "pre", "section", "article")
_BLOCK_TAG_RE = re.compile(r"</?(?:" + "|".join(_BLOCK_TAGS) + r")\b[^>]*>", re.IGNORECASE)
_WS_RE = re.compile(r"[ \t\xa0]+")  # \xa0: nbsp, once unescaped, collapses like a normal space
_BLANKLINES_RE = re.compile(r"\n{3,}")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)
_CHARSET_RE = re.compile(r'charset=["\']?([a-zA-Z0-9_\-]+)', re.IGNORECASE)


def _sniff_charset(body: bytes) -> str | None:
    """Look for a <meta charset=...> or <meta http-equiv="Content-Type"
    content="...charset=..."> declaration in the first 4 KB, ASCII-decoded
    (a charset declaration is itself always plain ASCII, even inside a
    page whose body is not). Returns a codec name Python recognizes, or
    None if there is no declaration or it names an unknown codec."""
    head = body[:4096].decode("ascii", errors="ignore")
    m = _CHARSET_RE.search(head)
    if not m:
        return None
    name = m.group(1).strip()
    try:
        codecs.lookup(name)
    except LookupError:
        return None
    return name


def _decode_body(body: bytes) -> str:
    """Decode a fetched body to text. clip_fetch strips any charset
    parameter off the HTTP Content-Type header (Task 2), so this is the
    only place that determines the actual character encoding: strict
    UTF-8 first (the common case, and the only one that must round-trip
    exactly); on failure, sniff a <meta charset> declaration out of the
    raw bytes and decode with that; failing that, cp1252 (a superset of
    Latin-1 that accepts any byte, so this never raises). Shared by every
    content type below instead of each branch calling .decode(...)
    separately."""
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        pass
    charset = _sniff_charset(body)
    if charset:
        try:
            return body.decode(charset, errors="replace")
        except Exception:  # pragma: no cover - defensive; codecs.lookup already validated the name
            pass
    return body.decode("cp1252", errors="replace")


def _html_title(html_text: str) -> str | None:
    m = _TITLE_RE.search(html_text)
    if not m:
        return None
    text = html.unescape(_TAG_RE.sub("", m.group(1))).strip()
    return text or None


def _fallback_markdown(html_text: str) -> str:
    """Tag-stripped plain text, used when trafilatura is unavailable,
    raises, or returns nothing. Not real markdown, just readable text,
    but keeps the clip usable instead of failing the whole request over a
    missing dependency, an internal trafilatura error, or a page
    trafilatura's readability heuristic gives up on. <head> (title/meta/
    script/style) is dropped first so its text never leaks into the body.
    Entities are unescaped LAST, after every tag is gone, so an entity
    like &lt;script&gt; in the visible text can't be mistaken for markup
    partway through."""
    text = _HEAD_RE.sub(" ", html_text)
    text = _SCRIPT_STYLE_RE.sub(" ", text)
    text = _BLOCK_TAG_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    text = _WS_RE.sub(" ", text)
    text = _BLANKLINES_RE.sub("\n\n", text)
    lines = [ln.strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln).strip()


def _title_fallback(meta_title: str | None, html_text: str | None, url: str) -> str:
    if meta_title and meta_title.strip():
        return meta_title.strip()
    if html_text:
        t = _html_title(html_text)
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
        text = _decode_body(fetched.body).strip()
        if not text:
            raise ExtractFailed("empty_body", f"empty {ctype} body")
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
            raise ExtractFailed("pdf_no_text", "pypdf found no extractable text in the PDF")
        return Extracted(title=_title_fallback(None, None, url), markdown=text.strip(),
                         byline=None, site_name=None, extractor="pdf")

    # text/html, application/xhtml+xml
    html_text = _decode_body(fetched.body)
    if trafilatura is not None:
        raw = None
        try:
            raw = trafilatura.extract(
                html_text, output_format="markdown", include_links=True,
                include_tables=True, with_metadata=True, url=fetched.final_url,
            )
        except Exception as exc:  # noqa: BLE001 - any trafilatura-internal failure degrades to the fallback, never a 500
            log.warning("clip_extract: trafilatura.extract failed (%s): %s", type(exc).__name__, exc)
        if raw and raw.strip():
            meta, body = _split_trafilatura_frontmatter(raw)
            markdown = body.strip()
            if markdown:
                return Extracted(
                    title=_title_fallback(meta.get("title"), html_text, url),
                    markdown=markdown,
                    byline=meta.get("author") or None,
                    site_name=meta.get("sitename") or meta.get("hostname") or None,
                    extractor="trafilatura",
                )
    # Fallback: trafilatura missing, raised, or returned nothing usable.
    markdown = _fallback_markdown(html_text)
    if not markdown:
        raise ExtractFailed("no_text", "no readable text found in the page")
    return Extracted(title=_title_fallback(None, html_text, url), markdown=markdown,
                     byline=None, site_name=None, extractor="fallback")
