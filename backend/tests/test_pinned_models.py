import pytest
from fastapi.testclient import TestClient

from backend import websearch
from backend.app import app


@pytest.fixture(autouse=True)
def _settings(tmp_path, monkeypatch):
    monkeypatch.setattr(websearch, "_SETTINGS_FILE", tmp_path / "settings.json")


def _get(c):
    return c.get("/api/pinned-models").json()["items"]


def test_empty_by_default():
    assert _get(TestClient(app)) == []


def test_pin_adds_in_order_and_is_idempotent():
    c = TestClient(app)
    a = {"model": "claude-opus-4-8", "endpoint_id": "claude-cli", "pinned": True}
    b = {"model": "gpt-5.4-mini", "endpoint_id": "openai", "pinned": True}
    assert c.post("/api/pinned-models", json=a).status_code == 200
    assert c.post("/api/pinned-models", json=b).status_code == 200
    assert c.post("/api/pinned-models", json=a).status_code == 200
    assert _get(c) == [
        {"model": "claude-opus-4-8", "endpoint_id": "claude-cli"},
        {"model": "gpt-5.4-mini", "endpoint_id": "openai"},
    ]


def test_same_model_on_two_endpoints_are_distinct_pins():
    c = TestClient(app)
    for ep in ("claude-cli", "perplexity-web"):
        c.post("/api/pinned-models", json={"model": "claude-sonnet-4-6", "endpoint_id": ep, "pinned": True})
    assert len(_get(c)) == 2


def test_unpin_removes_only_that_pair():
    c = TestClient(app)
    for ep in ("claude-cli", "perplexity-web"):
        c.post("/api/pinned-models", json={"model": "claude-sonnet-4-6", "endpoint_id": ep, "pinned": True})
    c.post("/api/pinned-models", json={"model": "claude-sonnet-4-6", "endpoint_id": "claude-cli", "pinned": False})
    assert _get(c) == [{"model": "claude-sonnet-4-6", "endpoint_id": "perplexity-web"}]


def test_missing_model_is_400():
    r = TestClient(app).post("/api/pinned-models", json={"endpoint_id": "x", "pinned": True})
    assert r.status_code == 400


def test_pinning_does_not_require_the_endpoint_to_be_online():
    r = TestClient(app).post("/api/pinned-models", json={"model": "m", "endpoint_id": "offline-ep", "pinned": True})
    assert r.status_code == 200


def test_non_string_model_is_400_not_500():
    r = TestClient(app).post("/api/pinned-models", json={"model": 5, "endpoint_id": "x", "pinned": True})
    assert r.status_code == 400


def test_string_false_unpins():
    c = TestClient(app)
    c.post("/api/pinned-models", json={"model": "m", "endpoint_id": "e", "pinned": True})
    c.post("/api/pinned-models", json={"model": "m", "endpoint_id": "e", "pinned": "false"})
    assert _get(c) == []


def test_corrupt_stored_value_reads_as_empty():
    websearch.save_settings({"pinned_models": 5})
    assert _get(TestClient(app)) == []
