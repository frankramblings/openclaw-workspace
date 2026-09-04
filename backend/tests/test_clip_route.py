"""POST /api/clip: route logic (validation, error mapping, document
create/update by source_url). clip_fetch.fetch is monkeypatched so no
network or trafilatura dependency is exercised here -- clip_guard,
clip_fetch, and clip_extract each have their own unit tests
(test_clip_guard.py, test_clip_fetch.py, test_clip_extract.py)."""
import time

import pytest
from fastapi.testclient import TestClient

from backend import clip, clip_extract, clip_fetch, clip_guard, documents
from backend.app import app
from backend.clip_fetch import Fetched


@pytest.fixture
def client():
    return TestClient(app)


def _fake_fetched(url="https://example.com/article", ctype="text/plain",
                  body=b"Hello world. This is the clipped article body."):
    return Fetched(final_url=url, content_type=ctype, body=body, redirects=[])


def test_clip_creates_a_library_document(client, vault_docs, monkeypatch):
    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return _fake_fetched()
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/article"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] is True
    doc = out["document"]
    assert doc["source_url"] == "https://example.com/article"
    assert doc["source_final_url"] == "https://example.com/article"
    assert "Hello world" in doc["current_content"]
    assert doc["current_content"].startswith(f"# {doc['title']}\n\n")
    assert out["mention"] == f"@[{doc['title']}](doc:{doc['id']})"
    assert out["meta"]["bytes"] == len(_fake_fetched().body)
    assert out["meta"]["content_type"] == "text/plain"


def test_clip_honors_title_override(client, vault_docs, monkeypatch):
    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return _fake_fetched()
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/article", "title": "My Custom Title"})
    assert r.json()["document"]["title"] == "My Custom Title"


def test_clip_updates_existing_document_by_source_url(client, vault_docs, monkeypatch):
    existing = vault_docs(
        "# Old Title\n\nSource: https://example.com/article\nClipped: 2026-01-01\n\nOld body.",
        title="Old Title", source_url="https://example.com/article",
        source_final_url="https://example.com/article", version_count=1,
    )
    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return _fake_fetched(body=b"Fresh body content.")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/article"})
    assert r.status_code == 200, r.text
    doc = r.json()["document"]
    assert doc["id"] == existing["id"]
    assert doc["version_count"] == 2
    assert "Fresh body content." in doc["current_content"]
    matches = [d for d in documents._scan_docs() if d.get("source_url") == "https://example.com/article"]
    assert len(matches) == 1  # updated in place, not duplicated


def test_clip_re_clip_snapshots_the_prior_body(client, vault_docs, monkeypatch):
    """Update-in-place (decision 7) must not silently clobber a user-edited
    body: re-clipping snapshots the pre-existing content via the same
    version-snapshot path save_document uses, so the prior (possibly
    user-edited) body is recoverable from /api/document/{id}/version/1."""
    existing = vault_docs(
        "# Old Title\n\nSource: https://example.com/article\nClipped: 2026-01-01\n\nUser-edited body, do not lose me.",
        title="Old Title", source_url="https://example.com/article",
        source_final_url="https://example.com/article", version_count=1,
    )
    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return _fake_fetched(body=b"Fresh body content.")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/article"})
    assert r.status_code == 200, r.text
    v1 = client.get(f"/api/document/{existing['id']}/version/1")
    assert v1.status_code == 200
    assert "User-edited body, do not lose me." in v1.json()["current_content"]


def test_clip_missing_url_is_bad_url(client, vault_docs):
    r = client.post("/api/clip", json={})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_url"


def test_clip_blocked_host_never_calls_fetch(client, vault_docs, monkeypatch):
    async def fake_fetch(*a, **kw):
        raise AssertionError("must not be called for a blocked host")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "http://127.0.0.1/admin"})
    assert r.status_code == 400
    assert r.json()["error"] == "blocked_host"


@pytest.mark.parametrize("exc,status,error", [
    (clip_fetch.FetchFailed("boom"), 502, "fetch_failed"),
    (clip_fetch.TooLarge("big"), 413, "too_large"),
    (clip_fetch.UnsupportedType("image/png"), 415, "unsupported_type"),
])
def test_clip_maps_fetch_errors(client, vault_docs, monkeypatch, exc, status, error):
    async def fake_fetch(*a, **kw):
        raise exc
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/a"})
    assert r.status_code == status
    assert r.json()["error"] == error


def test_clip_maps_fetch_errors_never_leaks_raw_detail(client, vault_docs, monkeypatch):
    """FetchFailed.detail may carry raw exception text (TLS error, internal
    IP, source path per clip_fetch's own docstring) -- the route must
    return .message (str(exc)), never .detail."""
    exc = clip_fetch.FetchFailed("transport", "request failed (ConnectError)",
                                  detail="ConnectError: connection refused to 10.0.0.5:443")
    async def fake_fetch(*a, **kw):
        raise exc
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/a"})
    assert r.status_code == 502
    assert r.json()["error"] == "fetch_failed"
    assert "10.0.0.5" not in r.json()["detail"]
    assert r.json()["detail"] == "request failed (ConnectError)"


def test_clip_dns_failed_maps_to_fetch_failed_not_blocked_host(client, vault_docs, monkeypatch):
    # A hostname that simply does not resolve (a typo'd domain) is not an
    # SSRF signal -- it must not read as "blocked_host" the way an actual
    # private-range address does.
    async def fake_fetch(*a, **kw):
        raise clip_guard.BlockedUrl("dns_failed", "could not resolve nonexistent.example: [Errno -2] Name or service not known")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://nonexistent.example/a"})
    assert r.status_code == 502
    assert r.json()["error"] == "fetch_failed"


def test_clip_extract_failed_on_empty_body(client, vault_docs, monkeypatch):
    async def fake_fetch(*a, **kw):
        return _fake_fetched(ctype="text/plain", body=b"   ")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/a"})
    assert r.status_code == 422
    assert r.json()["error"] == "extract_failed"


def test_clip_write_failure_returns_write_failed_without_raw_detail(client, vault_docs, monkeypatch):
    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return _fake_fetched()
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)

    def boom(doc):
        raise OSError("disk quota exceeded on /home/frank/.openclaw/workspace")
    monkeypatch.setattr(documents, "_write", boom)
    r = client.post("/api/clip", json={"url": "https://example.com/article"})
    assert r.status_code == 500
    assert r.json()["error"] == "write_failed"
    assert "/home/frank/.openclaw" not in r.json()["detail"]


def test_clip_mention_title_never_breaks_the_token_grammar(client, vault_docs, monkeypatch):
    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return _fake_fetched()
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/article", "title": "Breaking [Update]"})
    out = r.json()
    assert "]" not in out["mention"][2:out["mention"].index("](doc:")]


def test_clip_title_whitespace_is_collapsed_and_capped(client, vault_docs, monkeypatch):
    """Title hygiene (controller ruling): the extractor may hand back a raw
    <title> containing newlines/tabs and 500+ characters. The document
    title and the '# {title}' H1 must both be a single collapsed-whitespace
    line capped at 200 chars, not the raw extracted text."""
    messy_title = "  Breaking\n\tNews:   Something   Happened  " + ("x" * 300)
    body_html = f"<html><head><title>{messy_title}</title></head><body><p>Hello world, this is the article body text.</p></body></html>".encode()

    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return Fetched(final_url=url, content_type="text/html", body=body_html, redirects=[])
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/messy"})
    assert r.status_code == 200, r.text
    doc = r.json()["document"]
    assert "\n" not in doc["title"]
    assert "\t" not in doc["title"]
    assert not doc["title"].startswith(" ")
    assert not doc["title"].endswith(" ")
    assert "  " not in doc["title"]
    assert len(doc["title"]) <= 200
    assert doc["current_content"].startswith(f"# {doc['title']}\n\n")


def test_env_caps_are_registered_and_configurable(monkeypatch):
    """Fix round 1, Important 3: the caps are read fresh per call via
    clip._caps() (config._env_int/_env_float on every invocation), not
    cached as import-time module constants -- so this test monkeypatches
    the env and calls _caps() directly, with no importlib.reload(clip)
    needed and therefore no reload-mutated module state leaking into any
    later test in the session."""
    monkeypatch.setenv("WORKSPACE_CLIP_MAX_BYTES", "100000")
    monkeypatch.setenv("WORKSPACE_CLIP_TIMEOUT_S", "3")
    max_bytes, timeout_s = clip._caps()
    assert max_bytes == 100000
    assert timeout_s == 3.0


def test_caps_default_when_env_unset(monkeypatch):
    monkeypatch.delenv("WORKSPACE_CLIP_MAX_BYTES", raising=False)
    monkeypatch.delenv("WORKSPACE_CLIP_TIMEOUT_S", raising=False)
    max_bytes, timeout_s = clip._caps()
    assert max_bytes == clip._DEFAULT_MAX_BYTES
    assert timeout_s == clip._DEFAULT_TIMEOUT_S


def test_clip_body_must_be_a_json_object(client, vault_docs):
    r = client.post("/api/clip", content=b"[1, 2, 3]",
                    headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_clip_body_string_literal_is_bad_request(client, vault_docs):
    r = client.post("/api/clip", content=b'"just a string"',
                    headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_clip_non_string_title_is_bad_request(client, vault_docs, monkeypatch):
    async def fake_fetch(*a, **kw):
        raise AssertionError("must not fetch when the body fails validation")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/a", "title": 123})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_clip_non_string_session_id_is_bad_request(client, vault_docs, monkeypatch):
    async def fake_fetch(*a, **kw):
        raise AssertionError("must not fetch when the body fails validation")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/a", "session_id": ["nope"]})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_clip_unexpected_fetch_exception_maps_to_fetch_failed_not_a_bare_500(client, vault_docs, monkeypatch):
    """Fix round 1, Critical 2 belt-and-braces: an exception type
    clip_fetch never declares (RuntimeError here, standing in for anything
    unanticipated) must still map to 502/fetch_failed with the fixed safe
    message, never an unmapped 500 and never the raw exception text."""
    async def fake_fetch(*a, **kw):
        raise RuntimeError("boom: internal detail that must not leak")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/a"})
    assert r.status_code == 502
    assert r.json()["error"] == "fetch_failed"
    assert r.json()["detail"] == "fetch failed"
    assert "boom" not in r.json()["detail"]


def test_clip_h1_neutralizes_leading_hash_and_brackets(client, vault_docs, monkeypatch):
    """Minor fold-in: a page title shaped like markdown syntax (leading
    '#', a '[...]' pair) must not corrupt the '# {title}' H1 line when the
    body is rendered as markdown. doc['title'] itself is a plain-text
    field (never rendered as markdown) and is left unescaped."""
    messy_title = "#1 [Best] Deals"
    body_html = (f"<html><head><title>{messy_title}</title></head>"
                "<body><p>Hello world, this is the article body text.</p></body></html>").encode()

    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return Fetched(final_url=url, content_type="text/html", body=body_html, redirects=[])
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": "https://example.com/hashtitle"})
    assert r.status_code == 200, r.text
    doc = r.json()["document"]
    assert doc["title"] == "#1 [Best] Deals"
    h1_line = doc["current_content"].splitlines()[0]
    assert h1_line == "# \\#1 \\[Best\\] Deals"


@pytest.mark.parametrize("url", [
    "http://example.com:65536/",
    "http://example.com:abc/",
    "http://example.com:-1/",
])
def test_clip_bad_port_is_a_400_not_a_bare_500(client, vault_docs, monkeypatch, url):
    # Final review, Critical 2: parts.port raises ValueError for each of
    # these and the route only caught BlockedUrl, so all three were 500s.
    async def fake_fetch(*a, **kw):
        raise AssertionError("must not fetch a URL with a bad port")
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)
    r = client.post("/api/clip", json={"url": url})
    assert r.status_code == 400, r.text
    assert r.json()["error"] == "bad_url"


@pytest.mark.parametrize("timeout_env,expected", [
    ("inf", clip._MAX_TIMEOUT_S),
    ("0", clip._MIN_TIMEOUT_S),
    ("-5", clip._MIN_TIMEOUT_S),
    ("100000", clip._MAX_TIMEOUT_S),
    ("nan", clip._DEFAULT_TIMEOUT_S),
])
def test_caps_clamp_out_of_range_timeouts(monkeypatch, timeout_env, expected):
    # Final review, Minor 6: "inf" disabled the wall-clock budget entirely
    # and "nan" made every deadline comparison false, so the preemptive
    # check never fired.
    monkeypatch.setenv("WORKSPACE_CLIP_TIMEOUT_S", timeout_env)
    assert clip._caps()[1] == expected


@pytest.mark.parametrize("bytes_env,expected", [
    ("0", clip._MIN_MAX_BYTES),
    ("-1", clip._MIN_MAX_BYTES),
    ("10", clip._MIN_MAX_BYTES),
    ("999999999999", clip._MAX_MAX_BYTES),
])
def test_caps_clamp_out_of_range_byte_caps(monkeypatch, bytes_env, expected):
    monkeypatch.setenv("WORKSPACE_CLIP_MAX_BYTES", bytes_env)
    assert clip._caps()[0] == expected


def test_clip_extraction_that_runs_too_long_is_extract_failed(client, vault_docs, monkeypatch):
    """Final review, Minor 9: extraction had no time bound at all (the
    fetch budget covers only the fetch), so a pathological PDF could keep
    the request hanging for as long as pypdf took."""
    async def fake_fetch(url, *, max_bytes, timeout_s, resolver=None):
        return Fetched(final_url=url, content_type="text/html",
                       body=b"<html><body><p>hi</p></body></html>", redirects=[])
    monkeypatch.setattr(clip_fetch, "fetch", fake_fetch)

    def slow_extract(fetched, url):
        time.sleep(5)
        raise AssertionError("the request should not have waited for this")
    monkeypatch.setattr(clip_extract, "extract", slow_extract)
    monkeypatch.setattr(clip, "_EXTRACT_TIMEOUT_S", 0.05)
    r = client.post("/api/clip", json={"url": "https://example.com/slow"})
    assert r.status_code == 422, r.text
    assert r.json()["error"] == "extract_failed"
