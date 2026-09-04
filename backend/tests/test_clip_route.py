"""POST /api/clip: route logic (validation, error mapping, document
create/update by source_url). clip_fetch.fetch is monkeypatched so no
network or trafilatura dependency is exercised here -- clip_guard,
clip_fetch, and clip_extract each have their own unit tests
(test_clip_guard.py, test_clip_fetch.py, test_clip_extract.py)."""
import importlib

import pytest
from fastapi.testclient import TestClient

from backend import clip, clip_fetch, clip_guard, documents
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
    monkeypatch.setenv("WORKSPACE_CLIP_MAX_BYTES", "1000")
    monkeypatch.setenv("WORKSPACE_CLIP_TIMEOUT_S", "3")
    importlib.reload(clip)
    assert clip.MAX_BYTES == 1000
    assert clip.TIMEOUT_S == 3.0
