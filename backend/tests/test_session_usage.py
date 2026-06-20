"""Unit tests for the session-usage projection (footer wire contract).

`_project_session_usage` is pure — it trims a big gateway SessionsUsageResult
row down to the small footer shape — so we test it synchronously with a realistic
FULL row that carries EXTRA gateway fields and assert none of them leak. The two
async tests exercise `fetch_session_usage` with a monkeypatched gateway_call
(ok path + raise → {"ok": False}). sessions_store is isolated/empty via the
autouse _isolated_data_dir fixture, so model/provider come from the row only."""
import asyncio

import pytest

from backend import bridge, session_context


@pytest.fixture(autouse=True)
def _clear_live_cache():
    """The live-snapshot cache is process-global; isolate every test."""
    session_context.clear()
    yield
    session_context.clear()


def _full_opus_row():
    """A realistic gateway row with EXTRA fields that are NOT in the contract."""
    return {
        "key": "web:abc",
        "sessionId": "1fe81698ef72",
        "model": "claude-opus-4-8",
        "modelProvider": "anthropic",
        # Extra row-level fields that must not leak into the projection.
        "origin": "spa",
        "channel": "web",
        "usage": {
            "input": 12000,
            "output": 3400,
            "totalTokens": 20000,
            "totalCost": 0.1234567,
            "messageCounts": {"total": 42, "toolCalls": 7, "errors": 1},
            # Extra usage fields that must not leak.
            "cacheRead": 9999,
            "modelUsage": {"claude-opus-4-8": {"input": 12000}},
            "dailyBreakdown": [{"day": "2026-06-18", "totalTokens": 5000}],
        },
        "contextWeight": {
            "systemPrompt": {"chars": 8000},
        },
    }


def test_projection_trims_to_contract_and_drops_extras():
    out = bridge._project_session_usage("1fe81698ef72", "web:abc", {
        "sessions": [_full_opus_row()],
        "updatedAt": "2026-06-18T12:00:00Z",
    }, None)

    # (1) Exactly the expected top-level keys/values.
    assert set(out.keys()) == {
        "ok", "sessionId", "model", "modelProvider", "usage", "context", "updatedAt",
    }
    assert out["ok"] is True
    assert out["sessionId"] == "1fe81698ef72"
    assert out["model"] == "claude-opus-4-8"
    assert out["modelProvider"] == "anthropic"
    assert out["updatedAt"] == "2026-06-18T12:00:00Z"

    assert out["usage"] == {
        "totalTokens": 20000,
        "totalCost": round(0.1234567, 6),
        "inputTokens": 12000,
        "outputTokens": 3400,
        "messages": 42,
        "toolCalls": 7,
        "errors": 1,
    }

    # (3) opus → 200000 window; (4) usedPct = 20000/200000*100 = 10.0.
    assert out["context"]["windowTokens"] == 200000
    assert out["context"]["usedTokens"] == 20000
    assert out["context"]["usedPct"] == 10.0
    # No live snapshot → window comes from the model→window map, live flag off.
    assert out["context"]["contextWindowSource"] == "map"
    assert out["context"]["live"] is False

    # (5) systemPromptChars from contextWeight; tokens = chars/4; tokenEstimate.
    assert out["context"]["systemPromptChars"] == 8000
    assert out["context"]["systemPromptTokens"] == round(8000 / 4)
    assert out["context"]["tokenEstimate"] is True

    assert set(out["context"].keys()) == {
        "usedTokens", "windowTokens", "usedPct", "contextWindowSource", "live",
        "systemPromptChars", "systemPromptTokens", "tokenEstimate",
    }

    # (2) None of the extra gateway fields leak anywhere in the output tree.
    flat = repr(out)
    for leaked in ("cacheRead", "modelUsage", "dailyBreakdown", "origin",
                   "channel", "messageCounts", "9999"):
        assert leaked not in flat, f"extra gateway field leaked: {leaked}"


def test_projection_gpt5_window_and_pct():
    row = {
        "key": "web:abc",
        "model": "gpt-5.5",
        "modelProvider": "openai",
        "usage": {
            "input": 1000, "output": 1000, "totalTokens": 40000, "totalCost": 0,
            "messageCounts": {"total": 3, "toolCalls": 0, "errors": 0},
        },
    }
    out = bridge._project_session_usage("sid", "web:abc",
                                        {"sessions": [row], "updatedAt": None}, None)
    # (3) gpt-5 → 400000; (4) usedPct = 40000/400000*100 = 10.0.
    assert out["context"]["windowTokens"] == 400000
    assert out["context"]["usedPct"] == 10.0
    # No contextWeight → no systemPrompt fields.
    assert "systemPromptChars" not in out["context"]
    assert "tokenEstimate" not in out["context"]


def test_projection_prefers_live_snapshot():
    """A live `sessions.changed` snapshot overrides the usage aggregate for
    occupancy + window (the real numbers the Control UI shows)."""
    live = {
        "totalTokens": 138000,
        "contextTokens": 1048576,   # real Opus-1M window
        "totalTokensFresh": True,
        "model": "claude-opus-4-8",
        "estimatedCostUsd": 0,
        "updatedAt": 1781838500000,
    }
    # Usage row disagrees (cost-aggregate undercount + no window) — live wins.
    out = bridge._project_session_usage("sid", "web:abc", {
        "sessions": [{"key": "web:abc", "usage": {
            "totalTokens": 4039, "input": 4032, "output": 7,
            "messageCounts": {"total": 10, "toolCalls": 2, "errors": 0},
        }}],
    }, live)
    assert out["context"]["usedTokens"] == 138000
    assert out["context"]["windowTokens"] == 1048576
    assert out["context"]["usedPct"] == round(138000 / 1048576 * 100, 1)
    assert out["context"]["contextWindowSource"] == "gateway"
    assert out["context"]["live"] is True
    # Breakdown still comes from the usage RPC row.
    assert out["usage"]["messages"] == 10
    assert out["usage"]["toolCalls"] == 2
    assert out["model"] == "claude-opus-4-8"


def test_projection_tool_calls_prefers_live_tally():
    """The gateway reports toolCalls:0 for bridge sessions; our live tally wins."""
    live = {"totalTokens": 50000, "contextTokens": 1048576,
            "totalTokensFresh": True, "model": "claude-opus-4-8",
            "liveToolCalls": 7}
    out = bridge._project_session_usage("sid", "web:abc", {
        "sessions": [{"key": "web:abc", "usage": {
            "totalTokens": 4000,
            "messageCounts": {"total": 9, "toolCalls": 0, "errors": 0},
        }}],
    }, live)
    assert out["usage"]["toolCalls"] == 7   # max(gateway 0, live 7)
    assert out["usage"]["messages"] == 9


def test_bump_tool_calls_accumulates_and_survives_snapshot():
    """bump_tool_calls accumulates and the monitor's snapshot update preserves it."""
    key = "agent:main:web-xyz"
    session_context.bump_tool_calls(key)
    session_context.bump_tool_calls(key, 2)
    assert session_context.get(key)["liveToolCalls"] == 3
    # A subsequent sessions.changed update must not wipe the tally.
    session_context.update_from_event({
        "sessionKey": key, "phase": "end", "totalTokens": 123,
        "contextTokens": 1048576, "totalTokensFresh": True,
    })
    snap = session_context.get(key)
    assert snap["liveToolCalls"] == 3
    assert snap["totalTokens"] == 123


def test_projection_live_only_no_usage_row():
    """Live snapshot with NO usage row still yields ok:true (bar can render)."""
    live = {"totalTokens": 50000, "contextTokens": 272000,
            "totalTokensFresh": True, "model": "gpt-5.5"}
    out = bridge._project_session_usage("sid", "web:abc", None, live)
    assert out["ok"] is True
    assert out["context"]["usedTokens"] == 50000
    assert out["context"]["windowTokens"] == 272000
    assert out["context"]["live"] is True


def test_projection_empty_sessions_returns_not_ok():
    out = bridge._project_session_usage("sid", "web:abc",
                                        {"sessions": []}, None)
    assert out["ok"] is False
    assert out["sessionId"] == "sid"
    assert "reason" in out


def test_fetch_session_usage_ok(monkeypatch):
    """gateway_call returns a canned SessionsUsageResult → ok:true projection."""
    payload = {"sessions": [_full_opus_row()], "updatedAt": "2026-06-18T12:00:00Z"}

    async def fake_call(method, params=None, timeout=None):
        assert method == "sessions.usage"
        return payload

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    out = asyncio.run(bridge.fetch_session_usage("1fe81698ef72"))
    assert out["ok"] is True
    assert out["model"] == "claude-opus-4-8"
    assert out["usage"]["totalTokens"] == 20000
    assert out["context"]["windowTokens"] == 200000


def test_fetch_session_usage_gateway_error_and_no_live_returns_not_ok(monkeypatch):
    """Usage RPC down AND no live snapshot → {"ok": False} (never a 500)."""
    async def boom(method, params=None, timeout=None):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(bridge, "gateway_call", boom)
    out = asyncio.run(bridge.fetch_session_usage("someid"))
    assert out["ok"] is False
    assert out["sessionId"] == "someid"
    assert "reason" in out


def test_fetch_session_usage_live_only_when_usage_rpc_down(monkeypatch):
    """Usage RPC down but a live snapshot exists → ok:true from the live cache."""
    async def boom(method, params=None, timeout=None):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(bridge, "gateway_call", boom)
    # Seed the live cache for the resolved gateway key (unknown SPA id → web key).
    key = bridge.sessions_store.session_key_for("someid")
    session_context.update_from_event({
        "sessionKey": key, "phase": "end", "totalTokens": 99000,
        "contextTokens": 1048576, "totalTokensFresh": True,
        "model": "claude-opus-4-8",
    })
    out = asyncio.run(bridge.fetch_session_usage("someid"))
    assert out["ok"] is True
    assert out["context"]["usedTokens"] == 99000
    assert out["context"]["windowTokens"] == 1048576
    assert out["context"]["contextWindowSource"] == "gateway"
