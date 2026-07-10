"""Every exec-style tool_start the relay emits must also reach the launch
sniffer — and a sniffer that explodes must never break the relay."""
import asyncio

from backend import bridge, launch_sniffer
from backend.tests.test_bridge_relay import FakeWS


def _item_frame(name, meta, kind="command"):
    return {"type": "event", "event": "agent", "runId": "r1",
            "payload": {"runId": "r1", "stream": "item",
                        "data": {"kind": kind, "name": name, "meta": meta,
                                 "itemId": "i1", "phase": "start"}}}


def _tool_frame(name, command):
    return {"type": "event", "event": "agent", "runId": "r1",
            "payload": {"runId": "r1", "stream": "tool",
                        "data": {"name": name, "toolCallId": "t1",
                                 "phase": "start",
                                 "args": {"command": command}}}}


def _lifecycle_end():
    return {"type": "event", "event": "agent", "runId": "r1",
            "payload": {"runId": "r1", "stream": "lifecycle",
                        "data": {"phase": "end"}}}


def _drain(frames, monkeypatch, sniffer):
    # Reuses test_bridge_relay's FakeWS (a .recv() coroutine replaying JSON
    # strings) rather than the task brief's sketch — same harness pattern,
    # no need for a second one.
    monkeypatch.setattr(launch_sniffer, "on_tool_start", sniffer)

    async def main():
        return [c async for c in bridge._relay_events(
            FakeWS(frames), "r1", run_info={},
            session_key="agent:main:web-abc")]

    return asyncio.run(main())


def test_claude_cli_tool_start_reaches_sniffer(monkeypatch):
    calls = []
    _drain([_tool_frame("Bash", "nohup x &"), _lifecycle_end()], monkeypatch,
           lambda sk, name, cmd, **kw: calls.append((sk, name, cmd, kw)))
    assert calls == [("agent:main:web-abc", "Bash", "nohup x &",
                      {"item_is_command": False})]


def test_item_command_reaches_sniffer_with_flag(monkeypatch):
    calls = []
    _drain([_item_frame("run", "nohup x &"), _lifecycle_end()], monkeypatch,
           lambda sk, name, cmd, **kw: calls.append((name, cmd, kw)))
    assert calls == [("run", "nohup x &", {"item_is_command": True})]


def test_sniffer_crash_never_breaks_relay(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("sniffer exploded")

    out = _drain([_tool_frame("Bash", "nohup x &"), _lifecycle_end()],
                 monkeypatch, boom)
    assert any('"tool_start"' in c for c in out)
