"""The sniffer's async half: grace window, auto-registration, and the process
watcher. Everything external (promise creation, pid discovery, /proc) is
monkeypatched — the flow logic is what's under test."""
import asyncio
import re

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
    # The grace-pending counter must never leak past the registration
    # decision — the promise guard would stay wrongly suppressed for this
    # session key forever otherwise.
    assert launch_sniffer._GRACE_PENDING == {}


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
    assert launch_sniffer._GRACE_PENDING == {}


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


def test_find_pid_pattern_is_escaped(monkeypatch):
    captured = {}

    class _P:
        returncode = 1

        async def communicate(self):
            return b"", b""

    async def fake_exec(*argv, **kw):
        captured["argv"] = argv
        return _P()

    monkeypatch.setattr(launch_sniffer.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(launch_sniffer, "PID_TRIES", 1)
    # "| tee log" is truncated away by watch_pattern (redirection tokens never
    # appear in the child's argv) — what's left, "foo (build)", still needs
    # its parens regex-escaped so pgrep -f (an ERE) doesn't treat them as a
    # capture group.
    asyncio.run(launch_sniffer._find_pid("foo (build) | tee log"))
    argv = captured["argv"]
    assert argv[:4] == ("pgrep", "-f", "-n", "--")
    assert argv[4] == re.escape("foo (build)")


def test_watcher_stops_at_deadline(monkeypatch):
    created = _capture_promises(monkeypatch)
    monkeypatch.setattr(launch_sniffer.followup, "record_completion",
                        lambda pid, **kw: (_ for _ in ()).throw(AssertionError("must not complete")))
    monkeypatch.setattr(launch_sniffer, "_find_pid", _async_return(4242))
    monkeypatch.setattr(launch_sniffer, "_pid_alive", lambda pid, core: True)  # never exits
    monkeypatch.setattr(launch_sniffer, "AUTO_DEADLINE_S", 0.05)

    async def main():
        launch_sniffer.on_tool_start(SK, "Bash", "nohup ./daemon &")
        await asyncio.sleep(0.3)

    asyncio.run(main())
    assert len(created) == 1          # promise exists; watcher gave up quietly


def test_duplicate_launch_sniffed_once(monkeypatch):
    import asyncio
    created = _capture_promises(monkeypatch)
    monkeypatch.setattr(launch_sniffer, "_find_pid", _async_return(None))

    async def main():
        assert launch_sniffer.on_tool_start(SK, "Bash", "nohup ./render.sh &") is True
        assert launch_sniffer.on_tool_start(SK, "Bash", "nohup ./render.sh &") is False
        await asyncio.sleep(0.15)

    asyncio.run(main())
    assert len(created) == 1
    assert launch_sniffer._ACTIVE == set()      # entry released after _run ends


def test_cancel_all_stops_watchers(monkeypatch):
    import asyncio
    _capture_promises(monkeypatch)
    monkeypatch.setattr(launch_sniffer, "GRACE_S", 5.0)   # long grace: task stays live

    async def main():
        launch_sniffer.on_tool_start(SK, "Bash", "nohup ./render.sh &")
        await asyncio.sleep(0.02)
        n = launch_sniffer.cancel_all()
        await asyncio.sleep(0.02)
        return n

    assert asyncio.run(main()) == 1
    assert launch_sniffer._ACTIVE == set()


def _async_return(value):
    async def _inner(*a, **k):
        return value
    return _inner
