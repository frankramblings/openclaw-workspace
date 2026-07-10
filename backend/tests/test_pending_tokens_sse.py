import json

import pytest

from backend import event_store, pending_tokens


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    yield tmp_path


def test_register_and_emit_publishes_frame(store):
    sk = "agent:main:web-xyz"
    event_store.drop_session(sk)
    q = event_store.subscribe(sk)
    try:
        tok = pending_tokens.register_and_emit(
            sk, 7, kind="image", label="hi", source_ref="src-1")
        eid, payload = q.get_nowait()
        assert payload.startswith("data: ")
        body = json.loads(payload[len("data: "):].strip())
        assert body["type"] == "token.added"
        assert body["turn_id"] == 7
        assert body["token"]["id"] == tok["id"]
    finally:
        event_store.unsubscribe(sk, q)


def test_resolve_and_emit_publishes_frame(store):
    sk = "agent:main:web-xyz"
    event_store.drop_session(sk)
    tok = pending_tokens.register_and_emit(
        sk, 7, kind="image", label="hi", source_ref="src-1")
    q = event_store.subscribe(sk)
    try:
        removed = pending_tokens.resolve_and_emit(
            sk, 7, tok["id"], {"image_url": "u"})
        assert removed is not None
        eid, payload = q.get_nowait()
        body = json.loads(payload[len("data: "):].strip())
        assert body["type"] == "token.resolved"
        assert body["turn_id"] == 7
        assert body["token_id"] == tok["id"]
        assert body["payload"] == {"image_url": "u"}
        assert body["elapsed_ms"] >= 0
    finally:
        event_store.unsubscribe(sk, q)


def test_resolve_unknown_token_emits_nothing(store):
    sk = "agent:main:web-xyz"
    event_store.drop_session(sk)
    q = event_store.subscribe(sk)
    try:
        assert pending_tokens.resolve_and_emit(sk, 7, "nope", {}) is None
        assert q.empty()
    finally:
        event_store.unsubscribe(sk, q)
