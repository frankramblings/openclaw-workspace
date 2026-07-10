"""Tests for update_blocks persistence and the /api/pending/hydrate endpoint."""
import json

import pytest
from fastapi.testclient import TestClient

from backend import pending_tokens
from backend.app import app


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    yield tmp_path


# ── update_blocks persistence ─────────────────────────────────────────────────

def test_resolve_and_emit_persists_update_block(store):
    sk = "agent:main:web-h1"
    tok = pending_tokens.register(sk, 10, kind="image", label="sunset", source_ref="s1")
    pending_tokens.resolve_and_emit(sk, 10, tok["id"], {"image_url": "http://x/img.png"})

    blocks = pending_tokens.update_blocks_for_turn(sk, 10)
    assert len(blocks) == 1
    b = blocks[0]
    assert b["id"] == tok["id"]
    assert b["kind"] == "image"
    assert b["label"] == "sunset"
    assert b["payload"] == {"image_url": "http://x/img.png"}
    assert "resolved_at" in b
    assert "elapsed_ms" in b
    assert b["elapsed_ms"] >= 0


def test_multiple_resolves_accumulate_blocks(store):
    sk = "agent:main:web-h2"
    t1 = pending_tokens.register(sk, 20, kind="image", label="A", source_ref="r1")
    t2 = pending_tokens.register(sk, 20, kind="image", label="B", source_ref="r2")
    pending_tokens.resolve_and_emit(sk, 20, t1["id"], {"image_url": "u1"})
    pending_tokens.resolve_and_emit(sk, 20, t2["id"], {"image_url": "u2"})

    blocks = pending_tokens.update_blocks_for_turn(sk, 20)
    assert len(blocks) == 2
    assert {b["id"] for b in blocks} == {t1["id"], t2["id"]}


def test_update_blocks_for_turn_empty_when_no_resolve(store):
    sk = "agent:main:web-h3"
    pending_tokens.register(sk, 30, kind="image", label="x", source_ref="r")
    assert pending_tokens.update_blocks_for_turn(sk, 30) == []


def test_blocks_persist_across_load(store):
    sk = "agent:main:web-h4"
    tok = pending_tokens.register(sk, 40, kind="image", label="L", source_ref="r")
    pending_tokens.resolve_and_emit(sk, 40, tok["id"], {"image_url": "u"})

    raw = json.loads((store / "pending_tokens.json").read_text())
    assert "blocks" in raw
    key = f"{sk}:40"
    assert key in raw["blocks"]
    assert len(raw["blocks"][key]) == 1


# ── /api/pending/hydrate endpoint ─────────────────────────────────────────────

def test_hydrate_returns_both_fields(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    client = TestClient(app)
    sk = "agent:main:web-h5"
    tok = pending_tokens.register(sk, 50, kind="image", label="Z", source_ref="r")
    pending_tokens.resolve_and_emit(sk, 50, tok["id"], {"image_url": "http://img"})
    # A second token stays pending
    pending_tokens.register(sk, 50, kind="image", label="W", source_ref="r2")

    r = client.get(f"/api/pending/hydrate?session={sk}")
    assert r.status_code == 200
    data = r.json()
    assert "50" in data
    assert len(data["50"]["update_blocks"]) == 1
    assert data["50"]["update_blocks"][0]["payload"] == {"image_url": "http://img"}
    assert len(data["50"]["pending_tokens"]) == 1


def test_hydrate_filtered_by_turn_ids(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    client = TestClient(app)
    sk = "agent:main:web-h6"
    t1 = pending_tokens.register(sk, 1, kind="image", label="a", source_ref="r1")
    t2 = pending_tokens.register(sk, 2, kind="image", label="b", source_ref="r2")
    pending_tokens.resolve_and_emit(sk, 1, t1["id"], {"image_url": "u1"})
    pending_tokens.resolve_and_emit(sk, 2, t2["id"], {"image_url": "u2"})

    r = client.get(f"/api/pending/hydrate?session={sk}&turn_ids=1")
    assert r.status_code == 200
    data = r.json()
    assert "1" in data
    assert "2" not in data


def test_hydrate_unknown_session_returns_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    client = TestClient(app)
    r = client.get("/api/pending/hydrate?session=agent:main:web-NOPE")
    assert r.status_code == 200
    assert r.json() == {}


def test_hydrate_multi_turn_batch(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    client = TestClient(app)
    sk = "agent:main:web-h7"
    for tid in [10, 20, 30]:
        tok = pending_tokens.register(sk, tid, kind="image", label=f"t{tid}", source_ref="r")
        pending_tokens.resolve_and_emit(sk, tid, tok["id"], {"image_url": f"u{tid}"})

    r = client.get(f"/api/pending/hydrate?session={sk}")
    assert r.status_code == 200
    data = r.json()
    assert set(data.keys()) == {"10", "20", "30"}
    for k in ["10", "20", "30"]:
        assert len(data[k]["update_blocks"]) == 1
        assert data[k]["pending_tokens"] == []


def test_hydrate_no_session_param_returns_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    client = TestClient(app)
    r = client.get("/api/pending/hydrate")
    assert r.status_code == 200
    assert r.json() == {}
