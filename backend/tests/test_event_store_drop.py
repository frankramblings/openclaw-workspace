"""drop_session must forget ALL per-session state so deleting a chat doesn't leak
its buffers for the process lifetime (the maps are never otherwise evicted)."""
from backend import event_store


def test_drop_session_clears_all_state():
    key = "web-drop-me"
    event_store.begin_turn(key)
    event_store.append(key, 'data: {"delta": "hi"}\n\n')
    event_store.append(key, event_store._DONE_SSE if hasattr(event_store, "_DONE_SSE")
                        else "data: [DONE]\n\n")
    event_store.end_turn(key)
    assert event_store.since(key, None)  # has buffered events

    event_store.drop_session(key)

    assert event_store.since(key, None) == []
    assert event_store.latest_id(key) is None
    assert key not in event_store._EVENTS
    assert key not in event_store._NEXT_SEQ
    assert key not in event_store._TURN_ACTIVE
    assert key not in event_store._SUBSCRIBERS


def test_drop_session_is_idempotent():
    event_store.drop_session("never-existed")  # must not raise
