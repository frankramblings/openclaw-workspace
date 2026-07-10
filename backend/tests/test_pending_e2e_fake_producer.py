"""End-to-end integration test for the pending-token image_generate path.

Simulates what the gateway's image_generate hook does:
  1. A turn starts (begin_turn + first event appended)
  2. At spawn time: GET /api/pending/current-turn, then POST /api/pending/register
  3. The frontend receives a token.added SSE frame
  4. At completion: POST /api/pending/resolve with image_url payload
  5. The frontend receives a token.resolved SSE frame
  6. The token is gone from disk

This does NOT restart the gateway — it tests the HTTP surface directly.
"""
import json

import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend import event_store, pending_tokens


SESSION_KEY = "agent:main:web-e2etest"
CLIENT = TestClient(app)


@pytest.fixture(autouse=True)
def clean_session(tmp_path, monkeypatch):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    event_store.drop_session(SESSION_KEY)
    yield
    event_store.drop_session(SESSION_KEY)


def _start_turn():
    """Simulate a turn starting: begin + first event."""
    event_store.begin_turn(SESSION_KEY)
    event_store.append(SESSION_KEY, 'data: {"delta":"Generating your image..."}\n\n')


def test_full_image_generate_pending_cycle():
    _start_turn()

    # ── Step 2a: gateway asks for current turn_id ─────────────────────────────
    r = CLIENT.get("/api/pending/current-turn", params={"session": SESSION_KEY})
    assert r.status_code == 200
    body = r.json()
    turn_id = body["turn_id"]
    assert isinstance(turn_id, int)
    assert body["active"] is True

    # ── Step 2b: gateway registers a pending token ────────────────────────────
    r = CLIENT.post("/api/pending/register", data={
        "session": SESSION_KEY,
        "turn_id": str(turn_id),
        "kind": "image_generate",
        "label": "A cat wearing a space suit",
        "source_ref": "task-abc123",
    })
    assert r.status_code == 200
    token = r.json()["token"]
    assert token["kind"] == "image_generate"
    assert token["label"] == "A cat wearing a space suit"
    token_id = token["id"]

    # ── Step 3: verify token.added landed in event_store ─────────────────────
    info = event_store.current_turn(SESSION_KEY)
    frames = [e["data"] for e in info["events"]]
    added_frames = [json.loads(f.strip().removeprefix("data: "))
                    for f in frames
                    if "token.added" in f]
    assert len(added_frames) == 1
    assert added_frames[0]["type"] == "token.added"
    assert added_frames[0]["turn_id"] == turn_id
    assert added_frames[0]["token"]["id"] == token_id

    # ── Step 4: gateway resolves at completion ────────────────────────────────
    r = CLIENT.post("/api/pending/resolve", json={
        "session": SESSION_KEY,
        "turn_id": turn_id,
        "token_id": token_id,
        "payload": {
            "image_url": "/static/media/cat-space.png",
            "alt_text": "A cat wearing a space suit",
            "task_id": "task-abc123",
            "status": "ok",
        },
    })
    assert r.status_code == 200
    resolved = r.json()["resolved"]
    assert resolved["id"] == token_id
    assert "elapsed_ms" in resolved

    # ── Step 5: verify token.resolved landed in event_store ──────────────────
    info2 = event_store.current_turn(SESSION_KEY)
    frames2 = [e["data"] for e in info2["events"]]
    resolved_frames = [json.loads(f.strip().removeprefix("data: "))
                       for f in frames2
                       if "token.resolved" in f]
    assert len(resolved_frames) == 1
    rf = resolved_frames[0]
    assert rf["type"] == "token.resolved"
    assert rf["token_id"] == token_id
    assert rf["payload"]["image_url"] == "/static/media/cat-space.png"
    assert rf["payload"]["status"] == "ok"

    # ── Step 6: token is gone from disk ──────────────────────────────────────
    remaining = pending_tokens.for_turn(SESSION_KEY, turn_id)
    assert remaining == []


def test_resolve_unknown_token_returns_404():
    _start_turn()
    r = CLIENT.post("/api/pending/resolve", json={
        "session": SESSION_KEY,
        "turn_id": 1,
        "token_id": "nonexistent",
        "payload": {},
    })
    assert r.status_code == 404


def test_resolve_falls_back_on_unknown_session():
    r = CLIENT.post("/api/pending/resolve", json={
        "session": "not-a-real-session-key",
        "turn_id": 1,
        "token_id": "abc",
        "payload": {},
    })
    # _resolve_session_key treats any string with ':' as a valid session_key
    # so "not-a-real-session-key" (no colon) → 404
    # But "not:a:real" (has colons) → treated as literal session_key → 404 on token
    # Use a plain string without colons to get a 404 on session lookup
    assert r.status_code == 404


def test_prompt_label_truncation_contract():
    """Verify the gateway's label truncation rule (>60 chars → 57 + '...')."""
    long_prompt = "x" * 80
    expected = "x" * 57 + "..."
    _start_turn()
    r = CLIENT.get("/api/pending/current-turn", params={"session": SESSION_KEY})
    turn_id = r.json()["turn_id"]

    # Manually apply the same truncation the gateway JS does
    label = long_prompt[:57] + "..." if len(long_prompt) > 60 else long_prompt
    assert label == expected

    r2 = CLIENT.post("/api/pending/register", data={
        "session": SESSION_KEY,
        "turn_id": str(turn_id),
        "kind": "image_generate",
        "label": label,
        "source_ref": "task-trunc",
    })
    assert r2.status_code == 200
    assert r2.json()["token"]["label"] == expected
