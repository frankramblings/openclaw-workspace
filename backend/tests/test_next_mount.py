"""/next mount contract: the parallel frontend (frontend-next/dist) is served
at /next/ as a hash-routed SPA, and its presence never affects the classic app
at /. The mount is conditional at import time on config.NEXT_DIR existing, so
these tests run against the real build output (frontend-next/dist is built in
CI-less dev by `npm run build`; skip cleanly if it hasn't been)."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config


@pytest.fixture
def client():
    return TestClient(app_module.app)


needs_dist = pytest.mark.skipif(
    not (config.NEXT_DIR / "index.html").is_file(),
    reason="frontend-next/dist not built",
)


@needs_dist
def test_next_serves_spa_index(client):
    r = client.get("/next/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    # The Vite build's root element + base-pathed assets.
    assert 'id="root"' in r.text
    assert "/next/assets/" in r.text


@needs_dist
def test_next_assets_resolve(client):
    index = client.get("/next/").text
    # Pull one hashed asset path out of the served index and fetch it.
    import re

    m = re.search(r"/next/(assets/[^\"']+)", index)
    assert m, "no asset reference in /next/ index.html"
    r = client.get(f"/next/{m.group(1)}")
    assert r.status_code == 200


def test_classic_app_unaffected(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
