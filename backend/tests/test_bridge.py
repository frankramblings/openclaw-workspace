"""Unit tests for bridge pure functions (history mapping)."""
from backend.bridge import _map_history


def test_map_history_carries_per_message_timestamp():
    # The brain stores an epoch-ms `timestamp` on every message; the SPA renders
    # it via msg.metadata.timestamp and falls back to now() when it's missing
    # (the "every message shows the reload time" bug). The mapper must pass it.
    msgs = [
        {"role": "user", "content": "hi", "timestamp": 1780591399764},
        {"role": "assistant", "content": [{"type": "text", "text": "yo"}],
         "model": "gpt-5.5", "timestamp": 1780591402292},
    ]
    out = _map_history(msgs)
    assert out["history"][0]["role"] == "user"
    assert out["history"][0]["metadata"]["timestamp"] == 1780591399764
    assert out["history"][1]["metadata"]["timestamp"] == 1780591402292
    assert out["model"] == "gpt-5.5"


def test_map_history_tolerates_missing_timestamp():
    out = _map_history([{"role": "user", "content": "hi"}])
    # still maps; metadata.timestamp is None (frontend then falls back to now)
    assert out["history"][0]["metadata"]["timestamp"] is None
