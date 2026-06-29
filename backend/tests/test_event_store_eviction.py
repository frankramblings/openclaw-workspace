"""Ring-buffer eviction + stale-cursor safety for the resumable event log.

`event_store` retains at most MAX_PER_SESSION events per session (a bounded
deque). A long turn, or a client that reconnects with a cursor older than the
retained window, must NOT crash or return a negative/garbage slice — it should
degrade to "here's everything still retained". These tests pin that so a very
long-running turn can't blow memory or break resume.
"""
from backend import event_store


def _fresh_key(name: str) -> str:
    """A session key unique to this test; the module store is process-global so
    every test must use its own key to stay isolated."""
    return f"test:eviction:{name}"


def test_buffer_evicts_oldest_beyond_cap():
    key = _fresh_key("cap")
    n = event_store.MAX_PER_SESSION + 50
    for i in range(n):
        event_store.append(key, f"data: {i}\n\n")

    retained = event_store.since(key, None)
    # Never retains more than the cap...
    assert len(retained) == event_store.MAX_PER_SESSION
    # ...and it's the NEWEST events that survive (oldest 50 evicted).
    first_seq = int(retained[0][0])
    last_seq = int(retained[-1][0])
    assert last_seq == n  # seq is 1-based, so the nth append carries seq n
    assert first_seq == n - event_store.MAX_PER_SESSION + 1
    # The evicted payload is gone.
    assert "data: 0\n\n" not in [p for _id, p in retained]


def test_stale_cursor_older_than_window_returns_retained_window():
    """A cursor pointing at an event that has since been evicted must return the
    full retained buffer (the best we can do), not crash or slice negatively."""
    key = _fresh_key("stale-cursor")
    for i in range(event_store.MAX_PER_SESSION + 100):
        event_store.append(key, f"data: {i}\n\n")

    # seq=1 was evicted long ago; resuming from it should just hand back the
    # whole retained window without error.
    out = event_store.since(key, "1")
    assert len(out) == event_store.MAX_PER_SESSION
    # Every returned id is strictly greater than the (evicted) cursor.
    assert all(int(eid) > 1 for eid, _ in out)


def test_since_with_unparseable_cursor_returns_full_buffer():
    key = _fresh_key("bad-cursor")
    event_store.append(key, "data: a\n\n")
    event_store.append(key, "data: b\n\n")
    # Garbage / None cursor → treated as "from the beginning".
    assert len(event_store.since(key, "not-an-int")) == 2
    assert len(event_store.since(key, None)) == 2
    assert len(event_store.since(key, "")) == 2


def test_since_on_unknown_session_is_empty_not_error():
    assert event_store.since(_fresh_key("never-seen"), None) == []
    assert event_store.since(_fresh_key("never-seen-2"), "5") == []
    assert event_store.latest_id(_fresh_key("never-seen-3")) is None


def test_current_turn_clamps_events_to_retained_window():
    """If a turn's start boundary has aged out of the buffer, current_turn must
    still return a coherent (clamped) event list, not reach for evicted seqs."""
    key = _fresh_key("clamp")
    event_store.begin_turn(key)  # boundary = seq 1
    for i in range(event_store.MAX_PER_SESSION + 25):
        event_store.append(key, f"data: {i}\n\n")

    snap = event_store.current_turn(key)
    assert snap["active"] is True
    # Never returns more than what's retained.
    assert len(snap["events"]) <= event_store.MAX_PER_SESSION
    assert snap["last_event_id"] == event_store.latest_id(key)
    assert snap["elapsed_ms"] is not None and snap["elapsed_ms"] >= 0
    event_store.end_turn(key)
    assert event_store.current_turn(key)["active"] is False
