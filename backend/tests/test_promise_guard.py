"""'I'll let you know' with nothing registered = the empty promise this whole
project exists to kill. The detector is heuristic (false positive = one quiet
amber card); check_turn adds the "did anything register?" half."""
import pytest

from backend import chat_turn, promise_guard, task_registry, turn_state


@pytest.fixture(autouse=True)
def _fresh():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


@pytest.mark.parametrize("text,expected", [
    ("Kicked it off — I'll let you know when it's done.", True),
    ("I'll ping you once the render finishes.", True),
    ("Running now. I'll report back with the results.", True),
    ("I'll post the link when it lands.", True),
    ("once it's finished I'll update you", True),
    ("I'll keep you posted.", True),
    ("I’ll let you know when it’s done.", True),      # typographic apostrophe
    ("Once it’s finished I’ll update you", True),
    # curly-apostrophe variants of the six straight entries above
    ("Kicked it off — I’ll let you know when it’s done.", True),
    ("I’ll ping you once the render finishes.", True),
    ("Running now. I’ll report back with the results.", True),
    ("I’ll post the link when it lands.", True),
    ("once it’s finished I’ll update you", True),
    ("I’ll keep you posted.", True),
    ("I will let you know when it’s done.", True),        # uncontracted
    ("I will report back once the render lands.", True),
    ("I will ping you when it finishes.", True),
    ("I will keep you posted.", True),
    ("Done! Here's the file you asked for.", False),
    ("You should let me know if it breaks.", False),
    ("The render finished — no follow-up needed.", False),
    ("Will you let me know when it’s done?", False),      # question TO the user
    ("You will let me know if it breaks, right?", False),
    ("", False),
    (None, False),
])
def test_detect_promise(text, expected):
    assert (promise_guard.detect_promise(text) is not None) is expected


SK = "agent:main:web-abc123def456"


def test_check_turn_warns_when_nothing_registered(tmp_path, monkeypatch):
    from backend import config
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    turn_state.turn_started(SK)
    try:
        assert promise_guard.check_turn(SK, "I'll let you know when it's done") is not None
    finally:
        turn_state.turn_ended(SK)


def test_check_turn_quiet_when_registered(tmp_path, monkeypatch):
    from backend import config
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    turn_state.turn_started(SK)
    try:
        task_registry.upsert("followup:x", kind="followup", source="followup",
                             session_key=SK)
        assert promise_guard.check_turn(SK, "I'll let you know when it's done") is None
    finally:
        turn_state.turn_ended(SK)


def test_check_turn_ignores_auto_registrations(tmp_path, monkeypatch):
    # An auto task is the SNIFFER's doing, not Gary keeping his promise with
    # the wrapper — the card still isn't needed (the work IS tracked), so auto
    # counts as registered for the GUARD (unlike the sniffer's own grace
    # check). Pass exclude_kinds=() here.
    from backend import config
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    turn_state.turn_started(SK)
    try:
        task_registry.upsert("followup:a", kind="auto", source="followup",
                             session_key=SK)
        assert promise_guard.check_turn(SK, "I'll report back soon") is None
    finally:
        turn_state.turn_ended(SK)


def test_check_turn_quiet_while_grace_pending(tmp_path, monkeypatch):
    # A sniffed launch is mid-grace-window (registration outcome not decided
    # yet): the guard must stay quiet — the launch WILL be tracked one way or
    # another, so warning now would be the fast-turn contradiction (amber
    # card beside a row that pings).
    from backend import config, launch_sniffer
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    turn_state.turn_started(SK)
    try:
        monkeypatch.setitem(launch_sniffer._GRACE_PENDING, SK, 1)
        assert promise_guard.check_turn(SK, "I'll let you know when it's done") is None
    finally:
        launch_sniffer._GRACE_PENDING.pop(SK, None)
        turn_state.turn_ended(SK)


def test_drive_turn_emits_promise_warning(monkeypatch):
    # Integration seam: feed drive_turn a fake bridge stream whose reply is a
    # bare promise; assert the frame appears after text, before [DONE].
    import asyncio
    import json

    async def fake_stream(*a, **k):
        yield chat_turn.bridge._sse({"delta": "I'll let you know when it's done."})

    monkeypatch.setattr(chat_turn.bridge, "stream_turn", fake_stream)
    monkeypatch.setattr(chat_turn, "_late_reply", _async_none)

    async def main():
        frames = []
        async for chunk in chat_turn.drive_turn(
                message="go", use_web="", allow_web_search="", draft_doc=None,
                rec=None, session_key=SK, run_info={}, chat_attachments=[],
                title_task=None, active_runs={}, spawn=lambda c: c.close(),
                auto_extract=_async_none, log_turn_timing=lambda r: None):
            frames.append(chunk)
        return frames

    frames = asyncio.run(main())
    bodies = [json.loads(c[5:].strip()) for c in frames
              if c.startswith("data:") and c[5:].strip() not in ("", "[DONE]")
              and c[5:].strip().startswith("{")]
    warns = [b for b in bodies if b.get("type") == "promise_warning"]
    assert len(warns) == 1
    assert "let you know" in warns[0]["phrase"]


async def _async_none(*a, **k):
    return None
