"""HTTP contract for /api/pending/register and /api/pending/resolve."""
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend import pending_tokens


@pytest.fixture
def client():
    return TestClient(app)


def test_register_and_resolve_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    client = TestClient(app)
    r = client.post("/api/pending/register", data={
        "session": "agent:main:web-t",
        "turn_id": "9",
        "kind": "image",
        "label": "hello",
        "source_ref": "src-9",
    })
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    assert tok["kind"] == "image"

    r2 = client.post("/api/pending/resolve", json={
        "session": "agent:main:web-t",
        "turn_id": 9,
        "token_id": tok["id"],
        "payload": {"image_url": "u", "alt_text": "a"},
    })
    assert r2.status_code == 200, r2.text
    assert r2.json()["resolved"]["id"] == tok["id"]


def test_resolve_unknown_is_404(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    client = TestClient(app)
    r = client.post("/api/pending/resolve", json={
        "session": "agent:main:web-t",
        "turn_id": 1,
        "token_id": "missing",
        "payload": {},
    })
    assert r.status_code == 404


def test_token_enforced_when_configured(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    monkeypatch.setenv("FOLLOWUP_TOKEN", "sekret")
    client = TestClient(app)
    r = client.post("/api/pending/register", data={
        "session": "agent:main:web-t",
        "turn_id": "1",
        "kind": "image",
        "label": "x",
        "source_ref": "r",
    })
    assert r.status_code == 401
    r2 = client.post("/api/pending/register",
                     data={
                         "session": "agent:main:web-t",
                         "turn_id": "1",
                         "kind": "image",
                         "label": "x",
                         "source_ref": "r",
                     },
                     headers={"X-Workspace-Token": "sekret"})
    assert r2.status_code == 200
