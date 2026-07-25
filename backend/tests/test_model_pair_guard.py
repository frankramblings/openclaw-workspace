"""Cross-pair guard: PATCH/POST /api/session must reject a model that the
catalog places on a DIFFERENT endpoint (e.g. claude-cli + gpt-5.5 — the
"model not allowed" refs the gateway bounced on 2026-07-24), while staying
fail-open for models the catalog doesn't know (claude-opus-4-8[1m]-style
drift) and for catalog outages."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config, sessions_store
from backend.app import app


CATALOG = {"items": [
    {"endpoint_id": "claude-cli", "endpoint_name": "Claude CLI",
     "models": ["claude-opus-4-8", "claude-sonnet-4-6"],
     "models_extra": []},
    {"endpoint_id": "openai", "endpoint_name": "ChatGPT",
     "models": ["gpt-5.5", "gpt-5.4-mini"],
     "models_extra": []},
    {"endpoint_id": "perplexity-web", "endpoint_name": "Perplexity",
     "models": ["claude-sonnet-4-6"],
     "models_extra": []},
]}


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sessions_store, "_STORE_FILE", data_dir / "sessions.json")
    monkeypatch.setattr(config, "DATA_DIR", data_dir)


@pytest.fixture
def catalog(monkeypatch):
    async def fake_fetch_models():
        return CATALOG
    monkeypatch.setattr(app_module.bridge, "fetch_models", fake_fetch_models)


def _mk(model="claude-opus-4-8", endpoint_id="claude-cli"):
    rec = sessions_store.create(name="pair-test", model=model,
                                endpoint_id=endpoint_id)
    return rec["id"]


# --- PATCH ------------------------------------------------------------------

def test_patch_cross_pair_rejected(catalog):
    """model=gpt-5.5 onto a claude-cli record (no endpoint_id sent) is the
    exact bug: the stale endpoint would produce claude-cli/gpt-5.5."""
    sid = _mk()
    resp = TestClient(app).patch(f"/api/session/{sid}", data={"model": "gpt-5.5"})
    assert resp.status_code == 400
    assert sessions_store.get(sid)["model"] == "claude-opus-4-8"


def test_patch_valid_pair_accepted(catalog):
    sid = _mk()
    resp = TestClient(app).patch(
        f"/api/session/{sid}",
        data={"model": "gpt-5.5", "endpoint_id": "openai"})
    assert resp.status_code == 200
    rec = sessions_store.get(sid)
    assert (rec["endpoint_id"], rec["model"]) == ("openai", "gpt-5.5")


def test_patch_model_within_endpoint_accepted(catalog):
    sid = _mk()
    resp = TestClient(app).patch(
        f"/api/session/{sid}", data={"model": "claude-sonnet-4-6"})
    assert resp.status_code == 200
    assert sessions_store.get(sid)["model"] == "claude-sonnet-4-6"


def test_patch_endpoint_alone_cross_pair_rejected(catalog):
    sid = _mk(model="gpt-5.5", endpoint_id="openai")
    resp = TestClient(app).patch(
        f"/api/session/{sid}", data={"endpoint_id": "claude-cli"})
    assert resp.status_code == 400
    assert sessions_store.get(sid)["endpoint_id"] == "openai"


def test_patch_unknown_model_fails_open(catalog):
    """[1m]-style catalog drift: unknown ids are allowed through."""
    sid = _mk()
    resp = TestClient(app).patch(
        f"/api/session/{sid}", data={"model": "claude-opus-4-8[1m]"})
    assert resp.status_code == 200
    assert sessions_store.get(sid)["model"] == "claude-opus-4-8[1m]"


def test_patch_hidden_endpoint_fails_open(catalog):
    """'anthropic' is hidden from the catalog but valid gateway-side —
    an endpoint the catalog doesn't list is never a definite cross-pair."""
    sid = _mk(model="claude-opus-4-8", endpoint_id="anthropic")
    resp = TestClient(app).patch(
        f"/api/session/{sid}", data={"model": "claude-sonnet-4-6"})
    assert resp.status_code == 200


def test_patch_catalog_outage_fails_open(monkeypatch):
    async def boom():
        raise RuntimeError("gateway down")
    monkeypatch.setattr(app_module.bridge, "fetch_models", boom)
    sid = _mk()
    resp = TestClient(app).patch(f"/api/session/{sid}", data={"model": "gpt-5.5"})
    assert resp.status_code == 200


def test_patch_without_model_fields_skips_catalog(monkeypatch):
    """Renames/speed changes must not pay a gateway round-trip."""
    async def boom():
        raise AssertionError("fetch_models must not be called")
    monkeypatch.setattr(app_module.bridge, "fetch_models", boom)
    sid = _mk()
    resp = TestClient(app).patch(f"/api/session/{sid}", data={"name": "renamed"})
    assert resp.status_code == 200
    assert sessions_store.get(sid)["name"] == "renamed"


# --- POST create ------------------------------------------------------------

def test_create_cross_pair_rejected(catalog):
    resp = TestClient(app).post(
        "/api/session",
        data={"name": "bad", "model": "gpt-5.5", "endpoint_id": "claude-cli"})
    assert resp.status_code == 400


def test_create_valid_pair_accepted(catalog):
    resp = TestClient(app).post(
        "/api/session",
        data={"name": "ok", "model": "gpt-5.5", "endpoint_id": "openai"})
    assert resp.status_code == 200
    rec = sessions_store.get(resp.json()["id"])
    assert (rec["endpoint_id"], rec["model"]) == ("openai", "gpt-5.5")


def test_create_placeholder_untouched(monkeypatch):
    """The 'openclaw' bootstrap placeholder never hits the catalog."""
    async def boom():
        raise AssertionError("fetch_models must not be called")
    monkeypatch.setattr(app_module.bridge, "fetch_models", boom)
    resp = TestClient(app).post("/api/session", data={"name": "placeholder"})
    assert resp.status_code == 200


# --- bridge model pin -------------------------------------------------------
# A rejected sessions.patch/create must NOT record the pin: a poisoned pin made
# every later turn skip re-pinning and run on the gateway session's stale model
# (the stuck-on-perplexity failure of 2026-07-24).

import asyncio  # noqa: E402 - scoped to this section (house style)
import json  # noqa: E402 - scoped to this section (house style)

from backend import bridge  # noqa: E402 - scoped to this section (house style)


def _open_turn_with_gateway(monkeypatch, responses):
    """Run _open_turn with a fake gateway whose per-method responses come from
    `responses` ({method: payload}); returns the _pinned snapshot taken BEFORE
    cleanup."""
    methods = {}

    class WS:
        async def send(self, raw):
            msg = json.loads(raw)
            methods[msg["id"]] = msg.get("method")

    async def fake_connect():
        return WS()

    async def fake_await_response(ws, req_id):
        return responses.get(methods.get(req_id), {"ok": True, "payload": {}})

    monkeypatch.setattr(bridge, "_connect_and_auth", fake_connect)
    monkeypatch.setattr(bridge, "_await_response", fake_await_response)

    pinned = {}

    async def go():
        ws, run_id, use_warm = await bridge._open_turn(
            "hi", "k", "claude-cli/gpt-5.5", None, None, allow_warm=False)
        pinned.update(bridge._pinned)
        if use_warm:
            bridge._warm.lock.release()
        bridge._warm.ws = None
        bridge._pinned.clear()

    asyncio.run(go())
    return pinned


def test_rejected_pin_not_recorded(monkeypatch):
    pinned = _open_turn_with_gateway(monkeypatch, {
        "sessions.patch": {"ok": False, "error": "model not allowed"},
        "sessions.create": {"ok": False, "error": "model not allowed"},
    })
    assert "k" not in pinned


def test_successful_pin_recorded(monkeypatch):
    pinned = _open_turn_with_gateway(monkeypatch, {})
    assert pinned.get("k") == "claude-cli/gpt-5.5"
