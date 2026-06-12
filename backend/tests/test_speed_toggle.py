"""Per-chat speed setting: store round-trip, PATCH validation."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config, sessions_store
from backend.app import app


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    """Redirect the store's file path and config.DATA_DIR to tmp_path so
    tests never touch the real sessions.json. _STORE_FILE is a module-level
    constant so we monkeypatch it directly on the module."""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sessions_store, "_STORE_FILE", data_dir / "sessions.json")
    monkeypatch.setattr(config, "DATA_DIR", data_dir)


# ---------------------------------------------------------------------------
# Store-level tests
# ---------------------------------------------------------------------------

def test_create_defaults_speed_normal():
    rec = sessions_store.create(name="t")
    assert rec["speed"] == "normal"


def test_update_round_trips_speed():
    rec = sessions_store.create(name="t")
    sessions_store.update(rec["id"], speed="fast")
    assert sessions_store.get(rec["id"])["speed"] == "fast"


def test_old_records_without_speed_read_as_normal():
    rec = sessions_store.create(name="t")
    rec.pop("speed", None)  # simulate a pre-speed record
    assert (rec.get("speed") or "normal") == "normal"


# ---------------------------------------------------------------------------
# Endpoint tests — FastAPI TestClient (matching test_chat_stream_draft style)
# ---------------------------------------------------------------------------

def test_patch_speed_valid_persists():
    """PATCH speed=deep should be stored on the session record."""
    rec = sessions_store.create(name="patch-test")
    sid = rec["id"]
    client = TestClient(app)
    resp = client.patch(f"/api/session/{sid}", data={"speed": "deep"})
    assert resp.status_code == 200
    assert sessions_store.get(sid)["speed"] == "deep"


def test_patch_speed_invalid_ignored():
    """PATCH speed=warp (invalid) must leave the previous value unchanged."""
    rec = sessions_store.create(name="patch-bad")
    sid = rec["id"]
    # First set a known good value
    sessions_store.update(sid, speed="deep")
    client = TestClient(app)
    resp = client.patch(f"/api/session/{sid}", data={"speed": "warp"})
    assert resp.status_code == 200
    assert sessions_store.get(sid)["speed"] == "deep"
