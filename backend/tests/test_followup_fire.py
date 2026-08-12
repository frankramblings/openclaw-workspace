"""fire_followup: seeds a real turn through app's detached recorder, waits for
a busy session, retries when the gateway never acks, and resolves the promise
state. bridge.stream_turn is faked; the REAL _record_turn/_start_turn_recorder
run so the event_store wiring is exercised end-to-end."""
import asyncio

import pytest

from backend import app as app_module
from backend import event_store, followup, sessions_store


@pytest.fixture
def promise(monkeypatch, request):
    key = f"test:fire:{request.node.name}"
    rec = {"id": "abc123def456", "sessionKey": key, "archived": False,
           "model": "openclaw"}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)
    p = followup.create_promise(rec["id"], key, "render 566", 3600)
    followup.record_completion(p["id"], exit_code=0, duration_s=12, tail="ok")
    return p, key


def _fake_stream(reply="Here it is — 566 landed.", ack=True):
    async def fake(message, session_key=None, model_ref=None, attachments=None,
                   thinking=None, run_info=None):
        if ack and run_info is not None:
            run_info.setdefault("timing", {})["t_ack"] = 1.0
        yield f'data: {{"delta": "{reply}"}}\n\n'
        yield "data: [DONE]\n\n"
    return fake


def test_fire_records_turn_into_event_store(promise, monkeypatch):
    p, key = promise
    monkeypatch.setattr(followup.bridge, "stream_turn", _fake_stream())
    ok = asyncio.run(followup.fire_followup(p["id"]))
    assert ok is True
    assert followup.get_promise(p["id"])["state"] == "completed"
    payloads = "".join(pl for _, pl in event_store.since(key, None))
    assert "render 566" in payloads          # the ⚙️ card frame
    assert "566 landed" in payloads          # the reply delta
    assert "[DONE]" in payloads              # recorder's terminal frame
    assert key not in event_store.active_session_keys()   # end_turn ran


def test_fire_waits_for_busy_session(promise, monkeypatch):
    p, key = promise
    monkeypatch.setattr(followup.bridge, "stream_turn", _fake_stream())

    async def scenario():
        release = asyncio.Event()

        async def busy_turn():
            await release.wait()

        app_module._TURN_TASKS[key] = asyncio.create_task(busy_turn())
        fire = asyncio.create_task(followup.fire_followup(p["id"], _sleep=lambda s: asyncio.sleep(0)))
        await asyncio.sleep(0.05)
        assert followup.get_promise(p["id"])["state"] == "pending"  # still waiting
        release.set()
        assert await fire is True

    asyncio.run(scenario())
    assert followup.get_promise(p["id"])["state"] == "completed"


def test_fire_fails_after_no_ack_retries(promise, monkeypatch):
    p, key = promise
    monkeypatch.setattr(followup.bridge, "stream_turn", _fake_stream(ack=False))
    ok = asyncio.run(followup.fire_followup(p["id"], _sleep=lambda s: asyncio.sleep(0)))
    assert ok is False
    got = followup.get_promise(p["id"])
    assert got["state"] == "failed" and "ack" in got["error"]


def test_fire_missing_session_marks_failed(monkeypatch):
    monkeypatch.setattr(sessions_store, "get", lambda sid: None)
    p = followup.create_promise("ghost", "k", "t", 3600)
    followup.record_completion(p["id"], exit_code=0, duration_s=1, tail="")
    ok = asyncio.run(followup.fire_followup(p["id"]))
    assert ok is False
    assert followup.get_promise(p["id"])["state"] == "failed"


def test_spawn_fire_is_disabled_by_default(monkeypatch):
    from backend import config, followup
    monkeypatch.setattr(config, "FOLLOWUP_TURNS_ENABLED", False)
    assert followup._spawn_fire("anything") is False


# --- Change 4: promises must resolve even when turn-firing is disabled -----
#
# Task 6 gated _spawn_fire on FOLLOWUP_TURNS_ENABLED, which defaults off.
# mark() is only ever reached from inside fire_followup -- so with turns off,
# a promise declined by _spawn_fire never left "pending": the store grew
# without bound and the 30s sweeper kept re-selecting and re-logging it
# forever. _spawn_fire must resolve the promise itself in that case (no turn
# fired, but a terminal state reached) while still returning False.


def test_spawn_fire_resolves_completed_promise_when_turns_disabled(monkeypatch):
    from backend import config
    monkeypatch.setattr(config, "FOLLOWUP_TURNS_ENABLED", False)
    p = followup.create_promise("sid", "skey", "quiet task", 3600)
    followup.record_completion(p["id"], exit_code=0, duration_s=1.0, tail="ok")
    assert followup._spawn_fire(p["id"]) is False
    assert followup.get_promise(p["id"])["state"] == "completed"


def test_spawn_fire_resolves_overdue_promise_when_turns_disabled(monkeypatch):
    from backend import config
    monkeypatch.setattr(config, "FOLLOWUP_TURNS_ENABLED", False)
    p = followup.create_promise("sid", "skey", "silent task", 3600)
    assert followup._spawn_fire(p["id"], overdue=True) is False
    assert followup.get_promise(p["id"])["state"] == "overdue"


def test_spawn_fire_with_turns_enabled_behavior_is_unchanged(monkeypatch):
    from backend import config
    monkeypatch.setattr(config, "FOLLOWUP_TURNS_ENABLED", True)
    calls = []

    async def fake_fire(pid, *, overdue=False):
        calls.append((pid, overdue))
        return True

    monkeypatch.setattr(followup, "fire_followup", fake_fire)
    p = followup.create_promise("sid", "skey", "t", 3600)
    followup.record_completion(p["id"], exit_code=0, duration_s=1, tail="")

    async def run():
        return followup._spawn_fire(p["id"])

    spawned = asyncio.run(run())
    assert spawned is True
    assert calls == [(p["id"], False)]
    # Resolution is fire_followup's job (faked here as a no-op on state), not
    # _spawn_fire's -- the promise must NOT be resolved directly by the
    # disabled-turns shortcut when turns are actually enabled.
    assert followup.get_promise(p["id"])["state"] == "pending"
