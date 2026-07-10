"""The sniffer's async half: grace window, auto-registration, and the process
watcher. Everything external (promise creation, pid discovery, /proc) is
monkeypatched — the flow logic is what's under test."""
import asyncio

import pytest

from backend import launch_sniffer, task_registry


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    task_registry.reset_for_tests()
    monkeypatch.setattr(launch_sniffer, "GRACE_S", 0.02)
    monkeypatch.setattr(launch_sniffer, "WATCH_POLL_S", 0.02)
    monkeypatch.setattr(launch_sniffer, "PID_RETRY_S", 0.01)
    monkeypatch.setattr(launch_sniffer, "_session_id_for",
                        lambda sk: "abc123def456" if sk.startswith("agent:main:web-") else None)
    yield
    task_registry.reset_for_tests()


SK = "agent:main:web-abc123def456"


def _capture_promises(monkeypatch):
    created = []

    def fake_create(session_id, session_key, label, deadline_s, *,
                    origin="followup", turn_id=None):
        rec = {"id": f"p{len(created)}", "session_id": session_id,
               "session_key": session_key, "label": label,
               "deadline_s": deadline_s, "origin": origin, "turn_id": turn_id}
        created.append(rec)
        return rec

    monkeypatch.setattr(launch_sniffer.followup, "create_promise", fake_create)
    return created


def test_grace_expires_then_registers_and_watches(monkeypatch):
    created = _capture_promises(monkeypatch)
    pings = []
    monkeypatch.setattr(launch_sniffer.followup, "record_completion",
                        lambda pid, **kw: pings.append((pid, kw)) or True)
    monkeypatch.setattr(launch_sniffer, "_find_pid",
                        _async_return(4242))
    alive = {"n": 3}

    def fake_alive(pid, core):
        alive["n"] -= 1
        return alive["n"] > 0

    monkeypatch.setattr(launch_sniffer, "_pid_alive", fake_alive)

    async def main():
        assert launch_sniffer.on_tool_start(SK, "Bash", "nohup ./render.sh &") is True
        await asyncio.sleep(0.3)

    asyncio.run(main())
    assert len(created) == 1
    assert created[0]["origin"] == "auto"
    assert created[0]["label"] == "./render.sh"
    assert len(pings) == 1
    assert pings[0][0] == "p0" and pings[0][1]["exit_code"] == -1


def test_grace_registration_suppresses_auto(monkeypatch):
    created = _capture_promises(monkeypatch)

    async def main():
        assert launch_sniffer.on_tool_start(SK, "Bash", "nohup ./render.sh &") is True
        # A REAL registration lands during the grace window.
        task_registry.upsert("followup:real", kind="followup", source="followup",
                             session_key=SK)
        await asyncio.sleep(0.1)

    asyncio.run(main())
    assert created == []


def test_no_pid_leaves_deadline_only_promise(monkeypatch):
    created = _capture_promises(monkeypatch)
    pings = []
    monkeypatch.setattr(launch_sniffer.followup, "record_completion",
                        lambda pid, **kw: pings.append(pid) or True)
    monkeypatch.setattr(launch_sniffer, "_find_pid", _async_return(None))

    async def main():
        launch_sniffer.on_tool_start(SK, "Bash", "setsid ./worker")
        await asyncio.sleep(0.2)

    asyncio.run(main())
    assert len(created) == 1 and pings == []   # promise exists; deadline is the backstop


def test_gates_reject_nonqualifying_calls(monkeypatch):
    created = _capture_promises(monkeypatch)

    async def main():
        assert launch_sniffer.on_tool_start(SK, "TodoWrite", "nohup x &") is False
        assert launch_sniffer.on_tool_start(SK, "Bash", "ls -la") is False
        assert launch_sniffer.on_tool_start(None, "Bash", "nohup x &") is False
        assert launch_sniffer.on_tool_start("agent:main:signal", "Bash",
                                            "nohup x &") is False  # not a web chat
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert created == []


def test_no_running_loop_is_safe():
    assert launch_sniffer.on_tool_start(SK, "Bash", "nohup x &") is False


def _async_return(value):
    async def _inner(*a, **k):
        return value
    return _inner
