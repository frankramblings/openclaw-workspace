"""Tests for /sw.js scope route and gzip middleware."""
from pathlib import Path

from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config


def test_sw_route_serves_worker(monkeypatch, tmp_path: Path):
    (tmp_path / "sw.js").write_text("const CACHE_NAME = 'test';\n")
    monkeypatch.setattr(config, "FRONTEND_DIR", tmp_path)
    client = TestClient(app_module.app)
    res = client.get("/sw.js")
    assert res.status_code == 200
    assert "javascript" in res.headers["content-type"]
    # Must never be cached hard: the SW file is the update mechanism itself.
    assert "no-cache" in res.headers.get("cache-control", "")
    assert "CACHE_NAME" in res.text


def test_sw_route_404_when_missing(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(config, "FRONTEND_DIR", tmp_path / "nope")
    client = TestClient(app_module.app)
    assert client.get("/sw.js").status_code == 404


def test_gzip_middleware_registered():
    from starlette.middleware.gzip import GZipMiddleware
    assert any(m.cls is GZipMiddleware for m in app_module.app.user_middleware)


def test_gzip_compresses_large_json(monkeypatch):
    """Functional proof that gzip middleware is active: a >1KB response is
    returned compressed when the client sends Accept-Encoding: gzip."""
    # load_settings returns a small dict normally; pad it so the body exceeds
    # GZipMiddleware's minimum_size=1024 threshold.
    big_settings = {
        "search_provider": "serpapi",
        "search_result_count": 5,
        "pad": ["x" * 64] * 64,  # ~4KB
    }
    monkeypatch.setattr(
        "backend.websearch.load_settings",
        lambda: big_settings,
    )
    from backend import app as app_module  # local alias (module-level import shadowed)
    client = TestClient(app_module.app)
    res = client.get("/api/auth/settings", headers={"accept-encoding": "gzip"})
    assert res.status_code == 200
    assert res.headers.get("content-encoding") == "gzip"
