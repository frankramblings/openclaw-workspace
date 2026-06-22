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


def test_map_history_propagates_per_message_usage_metadata():
    # Data-rich chat parity: the gateway stamps each assistant turn with usage/
    # model/provider; the mapper must surface them on metadata for the drawer.
    msgs = [{
        "role": "assistant",
        "content": [{"type": "text", "text": "done"}],
        "model": "claude-opus-4-8",
        "provider": "claude-cli",
        "stopReason": "end_turn",
        "usage": {"input": 2, "output": 75, "cacheRead": 69469, "cacheWrite": 282},
    }]
    meta = _map_history(msgs)["history"][0]["metadata"]
    assert meta["usage"] == {"input": 2, "output": 75,
                             "cacheRead": 69469, "cacheWrite": 282}
    assert meta["model"] == "claude-opus-4-8"
    assert meta["provider"] == "claude-cli"
    assert meta["stopReason"] == "end_turn"
    assert "cost" not in meta  # plan-billed: no cost record


def test_map_history_usage_metadata_is_optional():
    # A turn with no usage/cost (e.g. plan-billed or partial) still maps cleanly,
    # carrying only what's present — no empty/None keys for absent fields.
    msgs = [{"role": "assistant", "content": [{"type": "text", "text": "hi"}]}]
    meta = _map_history(msgs)["history"][0]["metadata"]
    assert "usage" not in meta and "cost" not in meta and "provider" not in meta


def test_default_model_floats_to_front_of_its_provider(monkeypatch):
    """The SPA picker auto-defaults new chats to models[0] — that slot must be
    the configured primary, not whatever sorts first in the gateway catalog
    (gpt-5.4's arrival sorted ahead of gpt-5.5 and silently became the
    default for every new chat)."""
    from backend import bridge, config
    monkeypatch.setattr(config, "default_model", lambda: ("openai", "gpt-5.5"))
    payload = {"models": [
        {"id": "gpt-5.4", "provider": "openai", "name": "GPT-5.4"},
        {"id": "gpt-5.4-mini", "provider": "openai", "name": "GPT-5.4 mini"},
        {"id": "gpt-5.5", "provider": "openai", "name": "GPT-5.5"},
        {"id": "sonnet", "provider": "anthropic", "name": "Sonnet"},
    ]}
    out = bridge._build_model_items(payload, {})
    openai_item = next(i for i in out["items"] if i["endpoint_id"] == "openai")
    assert openai_item["models"][0] == "gpt-5.5"
    # Parallel display list must stay aligned with the reordered ids.
    assert openai_item["models_display"][0] == "GPT-5.5"
    # Non-default entries keep their relative order after the default.
    assert openai_item["models"][1:] == ["gpt-5.4", "gpt-5.4-mini"]
