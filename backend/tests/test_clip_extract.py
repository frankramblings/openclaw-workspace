"""backend/clip_extract.py: HTML/text/PDF -> markdown. trafilatura may or
may not actually be installed in this venv (backend/requirements.txt pins
it, but the operator installs it separately -- see Task 3 step 1) -- every
trafilatura-path test monkeypatches clip_extract.trafilatura with a small
fake so these pass whether or not the real package is present."""
import pytest

from backend import clip_extract as ce
from backend.clip_fetch import Fetched


class _FakeTrafilatura:
    def __init__(self, output):
        self._output = output
        self.calls = []

    def extract(self, html, **kwargs):
        self.calls.append((html, kwargs))
        return self._output


def _fetched(ctype, body: bytes, url="https://example.com/a"):
    return Fetched(final_url=url, content_type=ctype, body=body, redirects=[])


def test_extract_uses_trafilatura_frontmatter_for_title_byline_site(monkeypatch):
    output = (
        "---\n"
        "title: The Real Title\n"
        "author: Jane Doe\n"
        "sitename: Example News\n"
        "---\n\n"
        "# The Real Title\n\nBody text here.\n"
    )
    fake = _FakeTrafilatura(output)
    monkeypatch.setattr(ce, "trafilatura", fake)
    out = ce.extract(_fetched("text/html", b"<html><title>Fallback</title><body>x</body></html>"),
                     "https://example.com/a")
    assert out.title == "The Real Title"
    assert out.byline == "Jane Doe"
    assert out.site_name == "Example News"
    assert "Body text here." in out.markdown
    assert out.extractor == "trafilatura"
    (html_arg, kwargs), = fake.calls
    assert kwargs["output_format"] == "markdown"
    assert kwargs["include_links"] is True
    assert kwargs["include_tables"] is True
    assert kwargs["with_metadata"] is True


def test_extract_falls_back_when_trafilatura_module_is_missing(monkeypatch):
    monkeypatch.setattr(ce, "trafilatura", None)
    html = b"<html><head><title>Plain Title</title></head><body><p>Hello <b>world</b>.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert out.extractor == "fallback"
    assert out.title == "Plain Title"
    assert "Hello" in out.markdown and "world" in out.markdown
    assert "<p>" not in out.markdown
    assert "Plain Title" not in out.markdown  # <head> is stripped from the body text


def test_extract_falls_back_when_trafilatura_returns_nothing(monkeypatch):
    monkeypatch.setattr(ce, "trafilatura", _FakeTrafilatura(None))
    html = b"<html><head><title>T</title></head><body><p>Real text.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert out.extractor == "fallback"
    assert "Real text." in out.markdown


def test_extract_title_falls_back_to_url_when_no_title_anywhere(monkeypatch):
    monkeypatch.setattr(ce, "trafilatura", None)
    html = b"<html><body><p>No title tag here.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/no-title")
    assert out.title == "https://example.com/no-title"


def test_extract_passthrough_for_text_plain():
    out = ce.extract(_fetched("text/plain", b"Just plain text.\n"), "https://example.com/a.txt")
    assert out.markdown == "Just plain text."
    assert out.extractor == "passthrough"
    assert out.title == "https://example.com/a.txt"  # no metadata for plain text


def test_extract_passthrough_for_text_markdown():
    out = ce.extract(_fetched("text/markdown", b"# Already markdown\n"), "https://example.com/a.md")
    assert "# Already markdown" in out.markdown
    assert out.extractor == "passthrough"


def test_extract_raises_on_empty_text_plain():
    with pytest.raises(ce.ExtractFailed) as exc_info:
        ce.extract(_fetched("text/plain", b"   \n"), "https://example.com/a")
    assert exc_info.value.reason == "empty_body"


def test_extract_pdf_reuses_the_attachments_pypdf_helper(monkeypatch):
    calls = []
    def fake_extract_file_text(path, mime):
        calls.append((str(path), mime))
        return "## Page 1\nPDF text content."
    monkeypatch.setattr(ce.attachments, "_extract_file_text", fake_extract_file_text)
    out = ce.extract(_fetched("application/pdf", b"%PDF-1.4 fake bytes"), "https://example.com/a.pdf")
    assert "PDF text content." in out.markdown
    assert out.extractor == "pdf"
    (path, mime), = calls
    assert mime == "application/pdf" and path.endswith(".pdf")


def test_extract_raises_when_pdf_has_no_text(monkeypatch):
    monkeypatch.setattr(ce.attachments, "_extract_file_text", lambda path, mime: "")
    with pytest.raises(ce.ExtractFailed) as exc_info:
        ce.extract(_fetched("application/pdf", b"%PDF-1.4"), "https://example.com/a.pdf")
    assert exc_info.value.reason == "pdf_no_text"


def test_extract_raises_with_no_text_reason_when_html_has_no_readable_content(monkeypatch):
    monkeypatch.setattr(ce, "trafilatura", None)
    html = b"<html><head><title>Foo</title></head><body></body></html>"
    with pytest.raises(ce.ExtractFailed) as exc_info:
        ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert exc_info.value.reason == "no_text"


class _RaisingTrafilatura:
    """Simulates a trafilatura-internal failure (a signature mismatch, an
    unexpected page shape, an internal bug) -- must degrade to the
    fallback extractor, not escape as an exception."""

    def extract(self, html, **kwargs):
        raise TypeError("signature mismatch")


def test_extract_falls_back_when_trafilatura_raises(monkeypatch):
    monkeypatch.setattr(ce, "trafilatura", _RaisingTrafilatura())
    html = b"<html><head><title>T</title></head><body><p>Real text.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert out.extractor == "fallback"
    assert "Real text." in out.markdown


def test_extract_fallback_unescapes_html_entities_in_body(monkeypatch):
    monkeypatch.setattr(ce, "trafilatura", None)
    html = b"<html><body><p>Fish &amp; chips&nbsp;&#8217;tis tasty.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert "&amp;" not in out.markdown
    assert "&nbsp;" not in out.markdown
    assert "&#8217;" not in out.markdown
    assert "Fish & chips" in out.markdown
    assert "’tis tasty." in out.markdown


def test_extract_fallback_unescapes_html_entities_in_title(monkeypatch):
    monkeypatch.setattr(ce, "trafilatura", None)
    html = b"<html><head><title>Fish &amp; Chips</title></head><body><p>Body text.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert out.title == "Fish & Chips"


def test_extract_fallback_keeps_sentence_with_inline_tag_on_one_line(monkeypatch):
    monkeypatch.setattr(ce, "trafilatura", None)
    html = b"<html><body><p>First with <b>bold</b> and more.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert out.markdown == "First with bold and more."


def test_extract_fallback_separates_paragraphs_with_a_blank_line(monkeypatch):
    # Final review, Important 2: joined with a single "\n" every block ran
    # together, because a lone newline is a soft break in markdown, so a
    # clipped article rendered as one wall of text.
    monkeypatch.setattr(ce, "trafilatura", None)
    html = b"<html><body><p>First para.</p><p>Second para.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert out.markdown == "First para.\n\nSecond para."


def test_extract_fallback_strips_html_comments(monkeypatch):
    # Final review, Minor 8: a comment containing a '>' leaked its tail into
    # the text as "hidden -->".
    monkeypatch.setattr(ce, "trafilatura", None)
    html = b"<html><body><!-- <a>hidden</a> --><p>Visible.</p></body></html>"
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert out.markdown == "Visible."


def test_extract_fallback_does_not_treat_header_as_head(monkeypatch):
    # Final review, Minor 8: "<head[^>]*>" also matched "<header ...>", so a
    # page with an implicit </head> lost everything up to </header>.
    monkeypatch.setattr(ce, "trafilatura", None)
    html = (b"<html><header class=\"x\">Nav text</header>"
            b"<head><title>T</title></head><body><p>Body.</p></body></html>")
    out = ce.extract(_fetched("text/html", html), "https://example.com/a")
    assert "Body." in out.markdown
    assert "Nav text" in out.markdown


def test_decode_body_uses_meta_charset_for_iso_8859_1():
    html = ('<html><head><meta charset="iso-8859-1"></head>'
            '<body><p>Café résumé.</p></body></html>')
    body = html.encode("iso-8859-1")
    assert "Café résumé." in ce._decode_body(body)


def test_decode_body_never_raises_on_invalid_bytes_with_no_meta():
    body = b"Broken \xff\xfe bytes with no charset hint."
    text = ce._decode_body(body)
    assert isinstance(text, str)
    assert "Broken" in text


def test_decode_body_passes_utf8_through_unchanged():
    original = "Café straße 中文."
    assert ce._decode_body(original.encode("utf-8")) == original
