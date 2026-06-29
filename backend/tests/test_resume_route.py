"""HTTP-level tests for the resume/tail read endpoints (resume_route.py).

These pin the contract a reloaded SPA depends on:
- /api/chat/turn      → snapshot lets a fresh client detect an in-flight turn.
- /api/chat/events/resume → one-shot backlog replay, cursor-filtered, raw SSE
                            payloads preserved.
- /api/chat/stream    → live tail; replays backlog with `id:` framing and never
                        re-sends a backlog event on the live loop (seq dedupe).
- /api/chat/active_sessions → SPA ids of sessions currently streaming.

The store is process-global, so each test uses a unique gateway sessionKey and
maps a fake SPA session id onto it via sessions_store (monkeypatched).
"""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import event_store, sessions_store


@pytest.fixture
def client():
    return TestClient(app_module.app)


@pytest.fixture
def mapped_session(monkeypatch, request):
    """Wire a fake SPA session id → gateway key UNIQUE to this test so resume_route
    resolves to an event log no other test touches (the store is process-global)."""
    spa_id = f"test-spa-{request.node.name}"
    key = f"test:resume:{request.node.name}"

    def fake_get(sid):
        return {"sessionKey": key} if sid == spa_id else None

    def fake_id_for(k):
        return spa_id if k == key else None

    monkeypatch.setattr(sessions_store, "get", fake_get)
    monkeypatch.setattr(sessions_store, "id_for_session_key", fake_id_for)
    return spa_id, key


def test_turn_snapshot_reports_active_and_replays_events(client, mapped_session):
    spa_id, key = mapped_session
    event_store.begin_turn(key)
    event_store.append(key, "data: {\"t\":\"hello\"}\n\n")
    event_store.append(key, "data: {\"t\":\"world\"}\n\n")

    r = client.get(f"/api/chat/turn?session={spa_id}")
    assert r.status_code == 200
    snap = r.json()
    assert snap["active"] is True
    assert [e["data"] for e in snap["events"]] == [
        "data: {\"t\":\"hello\"}\n\n", "data: {\"t\":\"world\"}\n\n"]
    assert snap["last_event_id"] == event_store.latest_id(key)
    assert snap["elapsed_ms"] is not None
    event_store.end_turn(key)

    r2 = client.get(f"/api/chat/turn?session={spa_id}")
    assert r2.json()["active"] is False


def test_events_resume_is_cursor_filtered(client, mapped_session):
    spa_id, key = mapped_session
    e1 = event_store.append(key, "data: 1\n\n")
    _e2 = event_store.append(key, "data: 2\n\n")
    _e3 = event_store.append(key, "data: 3\n\n")

    # No cursor → full backlog.
    full = client.get(f"/api/chat/events/resume?session={spa_id}").json()
    assert [e["data"] for e in full["events"]] == ["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]
    assert full["last_event_id"] == event_store.latest_id(key)

    # Cursor at e1 → only events after it, raw payload preserved.
    after = client.get(
        f"/api/chat/events/resume?session={spa_id}&last_event_id={e1}").json()
    assert [e["data"] for e in after["events"]] == ["data: 2\n\n", "data: 3\n\n"]


def test_events_resume_honors_last_event_id_header(client, mapped_session):
    """EventSource's native reconnect sends Last-Event-ID as a header, not a
    query param — the endpoint must honor it."""
    spa_id, key = mapped_session
    e1 = event_store.append(key, "data: a\n\n")
    event_store.append(key, "data: b\n\n")

    r = client.get(f"/api/chat/events/resume?session={spa_id}",
                   headers={"Last-Event-ID": e1})
    assert [e["data"] for e in r.json()["events"]] == ["data: b\n\n"]


def test_stream_subscribe_before_replay_has_no_gap():
    """The live-tail contract: subscribe() must capture events appended AFTER
    subscribing, so the window between backlog replay and going live carries no
    gap. (Tested at the event_store level — the HTTP tail is an infinite SSE that
    a request client can't cleanly bound; the route just wraps this primitive.)"""
    key = "test:resume:nogap"
    event_store.append(key, "data: backlog\n\n")          # already retained
    q = event_store.subscribe(key)                         # route subscribes first...
    try:
        backlog = event_store.since(key, None)             # ...then replays backlog
        assert [p for _id, p in backlog] == ["data: backlog\n\n"]
        # An event appended in the replay→live window lands on the queue, not lost.
        live_id = event_store.append(key, "data: live\n\n")
        got_id, got_payload = q.get_nowait()
        assert (got_id, got_payload) == (live_id, "data: live\n\n")
    finally:
        event_store.unsubscribe(key, q)


def test_stream_live_event_dedupes_against_backlog():
    """If an append races between replay and the live loop, the route's seq guard
    (replayed_max) must not double-emit. Mirror that guard here: an event whose
    seq <= the max already replayed is dropped."""
    key = "test:resume:dedupe"
    e1 = event_store.append(key, "data: 1\n\n")
    q = event_store.subscribe(key)
    try:
        # Backlog replay covers e1; the same event also queued on a race would be
        # filtered because its seq <= replayed_max.
        replayed = event_store.since(key, None)
        replayed_max = max(int(eid) for eid, _ in replayed)
        assert replayed_max == int(e1)
        # A genuinely newer event is NOT filtered.
        e2 = event_store.append(key, "data: 2\n\n")
        nid, _ = q.get_nowait()
        assert int(nid) > replayed_max == int(e1)
        assert nid == e2
    finally:
        event_store.unsubscribe(key, q)


def test_active_sessions_lists_streaming_spa_ids(client, mapped_session):
    spa_id, key = mapped_session
    # Not active yet.
    assert spa_id not in client.get("/api/chat/active_sessions").json()["active"]
    event_store.begin_turn(key)
    assert spa_id in client.get("/api/chat/active_sessions").json()["active"]
    event_store.end_turn(key)
    assert spa_id not in client.get("/api/chat/active_sessions").json()["active"]
