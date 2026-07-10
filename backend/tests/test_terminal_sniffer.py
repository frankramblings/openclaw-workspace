"""The workspace terminal endpoint is Gary's real exec path — background
launches submitted through it must reach the launch sniffer with the CHAT
session key (live-fire 2026-07-10: bare `nohup sleep 90 &` via
/api/terminal/mcp/run produced no auto task because only the bridge was
hooked and it sees just the curl wrapper)."""
import pytest

from backend import sessions_store, terminals


@pytest.fixture
def _session(monkeypatch):
    rec = {"id": "abc123def456", "sessionKey": "agent:main:web-abc123def456"}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)
    return rec


def test_terminal_command_reaches_sniffer(monkeypatch, _session):
    calls = []
    from backend import launch_sniffer
    monkeypatch.setattr(launch_sniffer, "on_tool_start",
                        lambda sk, name, cmd, **kw: calls.append((sk, name, cmd, kw)))
    terminals._sniff_terminal_command("abc123def456", "nohup sleep 90 &")
    assert calls == [("agent:main:web-abc123def456", "terminal", "nohup sleep 90 &",
                      {"item_is_command": True})]


def test_global_terminal_key_skipped(monkeypatch, _session):
    calls = []
    from backend import launch_sniffer
    monkeypatch.setattr(launch_sniffer, "on_tool_start",
                        lambda *a, **kw: calls.append(a))
    terminals._sniff_terminal_command("global", "nohup x &")
    assert calls == []


def test_sniffer_crash_never_breaks_terminal(monkeypatch, _session):
    from backend import launch_sniffer

    def boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(launch_sniffer, "on_tool_start", boom)
    terminals._sniff_terminal_command("abc123def456", "nohup x &")   # must not raise
