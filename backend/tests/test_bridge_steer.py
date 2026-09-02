import pytest

from backend import bridge


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_steer_turn_sends_chat_send_on_the_session(monkeypatch):
    calls = []

    async def fake_call(method, params=None, timeout=30.0):
        calls.append((method, params, timeout))
        return {"runId": "run-9", "status": "started"}

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    ack = await bridge.steer_turn("agent:main:web:abc", "prefer the smaller patch\x00")
    assert ack == {"runId": "run-9", "status": "started"}
    method, params, timeout = calls[0]
    assert method == "chat.send"
    assert params["sessionKey"] == "agent:main:web:abc"
    assert params["message"] == "prefer the smaller patch"      # NULs stripped
    assert params["deliver"] is False
    assert len(params["idempotencyKey"]) == 32
    assert "attachments" not in params
    assert timeout <= 20


@pytest.mark.anyio
async def test_steer_turn_propagates_gateway_failure(monkeypatch):
    async def fake_call(method, params=None, timeout=30.0):
        raise RuntimeError("chat.send failed: {'ok': False}")

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    with pytest.raises(RuntimeError):
        await bridge.steer_turn("agent:main:web:abc", "x")
