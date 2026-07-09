"""Behavioral tests for workspace_watch.py (the doc-editor filesystem
change broadcaster).

The one real external-service boundary in this module is `watchfiles.awatch`
(Rust-backed inotify) — everything else (subscriber fan-out, path filtering,
the subscribe/unsubscribe/ping WebSocket protocol, the watcher task
lifecycle) is plain in-process asyncio code and is exercised for real here,
against real tmp_path files and a real (in-process) WebSocket via TestClient.

Only `_watcher`'s two tests fake the awatch boundary:
  - "absent" simulates watchfiles not being importable (audited as a
    "silent no-op" risk: `backend/requirements.txt` doesn't pin watchfiles,
    so a floor install can lack it) by pointing sys.modules["watchfiles"] at
    None, the standard way to force `from watchfiles import awatch` to raise
    ImportError regardless of whether the package is actually installed.
  - "present" swaps in a fake module exposing a one-shot async-generator
    `awatch`, since driving the real Rust/inotify watcher deterministically
    in a unit test isn't practical (it depends on the OS's inotify queue
    timing). The fake yields exactly one change batch and then finishes,
    so `_watcher()`'s `async for` loop drains it and returns on its own —
    no cancellation or timing assumptions needed.

Note: the code path exercised by the "absent" test currently has no logging
statement (`except Exception: return`) — it degrades silently rather than
logging once. The test below asserts the actual behavior (clean, silent
exit); it does not assert a log record, since none is emitted today.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import types

import pytest
from fastapi.testclient import TestClient

from backend import vault_store as vs
from backend import workspace_watch


@pytest.fixture(autouse=True)
def _reset_module_state():
    """_subscribers/_watch_task/_broadcast_loop are process-wide globals —
    reset around every test so one test's subscriber/task can't leak into
    the next."""
    workspace_watch._subscribers.clear()
    workspace_watch._watch_task = None
    workspace_watch._broadcast_loop = None
    yield
    workspace_watch._subscribers.clear()
    workspace_watch._watch_task = None
    workspace_watch._broadcast_loop = None


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _FakeWS:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_json(self, payload):
        self.sent.append(payload)


# --- _rel_workspace: absolute -> workspace-relative -------------------------

def test_rel_workspace_returns_relative_path_within_root(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    abs_path = str(tmp_path / "notes" / "a.md")
    assert workspace_watch._rel_workspace(abs_path) == "notes/a.md"


def test_rel_workspace_root_itself_is_empty_string(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    assert workspace_watch._rel_workspace(str(tmp_path)) == ""


def test_rel_workspace_path_outside_root_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path / "ws")
    assert workspace_watch._rel_workspace("/some/other/place.md") is None


# --- _interesting: binary/protected-segment filtering ------------------------

def test_interesting_rejects_binary_extension():
    assert workspace_watch._interesting("/x/y/photo.png") is False


def test_interesting_rejects_protected_segment_anywhere_in_path():
    assert workspace_watch._interesting("/x/.git/HEAD") is False
    assert workspace_watch._interesting("/x/node_modules/pkg/index.js") is False


def test_interesting_accepts_known_text_extension():
    assert workspace_watch._interesting("/x/notes/a.md") is True


def test_interesting_accepts_extensionless_file():
    # Frank edits SKILL/README/dotfiles with no suffix.
    assert workspace_watch._interesting("/x/SKILL") is True


def test_interesting_accepts_unknown_extension_ambiguously():
    assert workspace_watch._interesting("/x/thing.xyz") is True


# --- _fan_out: per-subscriber path filtering + dead-socket cleanup ----------

@pytest.mark.anyio
async def test_fan_out_sends_only_to_matching_subscriber(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    target = tmp_path / "note.md"
    target.write_text("hi")

    ws_match, ws_other, ws_any = _FakeWS(), _FakeWS(), _FakeWS()
    workspace_watch._subscribers.extend([
        {"ws": ws_match, "paths": {str(target)}},
        {"ws": ws_other, "paths": {str(tmp_path / "other.md")}},
        {"ws": ws_any, "paths": set()},  # empty paths == "any change"
    ])

    await workspace_watch._fan_out(str(target))

    assert len(ws_match.sent) == 1 and ws_match.sent[0]["path"] == "note.md"
    assert ws_other.sent == []
    assert len(ws_any.sent) == 1


@pytest.mark.anyio
async def test_fan_out_missing_file_reports_zero_mtime(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    ws = _FakeWS()
    workspace_watch._subscribers.append({"ws": ws, "paths": set()})

    await workspace_watch._fan_out(str(tmp_path / "gone.md"))

    assert ws.sent[0]["mtime_ns"] == 0
    assert ws.sent[0]["abs_path"] == str(tmp_path / "gone.md")


@pytest.mark.anyio
async def test_fan_out_drops_subscriber_whose_send_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    target = tmp_path / "note.md"
    target.write_text("hi")

    class _DeadWS:
        async def send_json(self, payload):
            raise RuntimeError("socket closed")

    entry = {"ws": _DeadWS(), "paths": set()}
    workspace_watch._subscribers.append(entry)

    await workspace_watch._fan_out(str(target))

    assert entry not in workspace_watch._subscribers


# --- publish_change: sync -> async bridge for direct callers (e.g. PUT) ----

def test_publish_change_noop_when_not_interesting(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    monkeypatch.setattr(workspace_watch, "_broadcast_loop", object())  # would blow up if used
    workspace_watch.publish_change(str(tmp_path / "photo.png"))  # binary -> filtered, no-op


def test_publish_change_noop_when_broadcast_loop_unset(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    assert workspace_watch._broadcast_loop is None
    workspace_watch.publish_change(str(tmp_path / "a.md"))  # must not raise


@pytest.mark.anyio
async def test_publish_change_schedules_fan_out_on_the_broadcast_loop(tmp_path, monkeypatch):
    """publish_change is fire-and-forget (asyncio.run_coroutine_threadsafe,
    result discarded) so the only way to observe delivery is to let the
    already-running loop take its next scheduling turns. This is
    deterministic here (single-threaded test loop, nothing else scheduled,
    a trivial no-further-await coroutine) — not a wall-clock wait, just a
    bounded number of yields with a generous cap."""
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    target = tmp_path / "note.md"
    target.write_text("hi")
    monkeypatch.setattr(workspace_watch, "_broadcast_loop", asyncio.get_running_loop())
    ws = _FakeWS()
    workspace_watch._subscribers.append({"ws": ws, "paths": set()})

    workspace_watch.publish_change(str(target), mtime_ns=123)
    for _ in range(50):
        if ws.sent:
            break
        await asyncio.sleep(0)

    assert ws.sent, "fan-out never ran on the broadcast loop"
    assert ws.sent[0] == {"type": "file_changed", "abs_path": str(target),
                          "path": "note.md", "mtime_ns": 123}


# --- _watcher: watchfiles absent (required) ----------------------------------

@pytest.mark.anyio
async def test_watcher_exits_cleanly_when_watchfiles_import_fails(
        tmp_path, monkeypatch, caplog):
    """sys.modules[name] = None is the standard way to force `from X import Y`
    to raise ImportError regardless of whether X is actually installed —
    simulates the floor-install case where watchfiles is absent.

    WORKSPACE must point at an EXISTING dir (tmp_path): if a regression made
    the ImportError fall through instead of returning, the very next guard
    (`if not os.path.isdir(root): return`) would mask it on any machine
    without the real ~/.openclaw/workspace — the test must fail via the
    unreachable awatch call, not accidentally pass via the isdir bail-out."""
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    monkeypatch.setitem(sys.modules, "watchfiles", None)

    with caplog.at_level(logging.WARNING):
        await workspace_watch._watcher()  # must return (not raise, not hang)

    assert workspace_watch._subscribers == []  # never even reached the fan-out
    # KNOWN GAP, pinned deliberately: the absent-watchfiles path is a SILENT
    # no-op today (`except Exception: return`, no log statement). If someone
    # later adds the missing warning log, flip this to assert the record
    # EXISTS instead.
    assert caplog.records == []


# --- _watcher: watchfiles present (faked awatch boundary) -------------------

@pytest.mark.anyio
async def test_watcher_present_path_fans_out_events_from_one_batch(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    keep = tmp_path / "note.md"
    keep.write_text("hello")
    skip = tmp_path / "image.png"  # binary -> _interesting() filters it out
    skip.write_bytes(b"\x89PNG")

    async def fake_awatch(root, recursive=True, stop_event=None):
        assert root == str(tmp_path)
        yield {("added", str(keep)), ("added", str(skip))}

    fake_mod = types.ModuleType("watchfiles")
    fake_mod.awatch = fake_awatch
    monkeypatch.setitem(sys.modules, "watchfiles", fake_mod)

    ws = _FakeWS()
    workspace_watch._subscribers.append({"ws": ws, "paths": set()})

    await workspace_watch._watcher()  # the fake yields once then StopAsyncIteration -> returns

    assert len(ws.sent) == 1  # skip.png never reached _fan_out
    assert ws.sent[0]["path"] == "note.md"
    assert ws.sent[0]["mtime_ns"] > 0


@pytest.mark.anyio
async def test_watcher_returns_immediately_when_workspace_dir_missing(tmp_path, monkeypatch):
    missing = tmp_path / "does-not-exist"
    monkeypatch.setattr(vs, "WORKSPACE", missing)

    called = False

    async def fake_awatch(*a, **kw):
        nonlocal called
        called = True
        yield set()  # pragma: no cover - must never run

    fake_mod = types.ModuleType("watchfiles")
    fake_mod.awatch = fake_awatch
    monkeypatch.setitem(sys.modules, "watchfiles", fake_mod)

    await workspace_watch._watcher()

    assert called is False  # bailed out on the isdir check before ever calling awatch


# --- start_watcher / stop: task lifecycle ------------------------------------

@pytest.mark.anyio
async def test_start_watcher_is_idempotent_and_stop_cancels_cleanly(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path / "does-not-exist")

    assert workspace_watch._watch_task is None
    workspace_watch.start_watcher()
    task1 = workspace_watch._watch_task
    assert task1 is not None
    assert workspace_watch._broadcast_loop is asyncio.get_running_loop()

    workspace_watch.start_watcher()  # second call: no-op, same task
    assert workspace_watch._watch_task is task1

    await workspace_watch.stop()
    assert workspace_watch._watch_task is None


@pytest.mark.anyio
async def test_stop_without_start_is_a_noop():
    assert workspace_watch._watch_task is None
    await workspace_watch.stop()  # must not raise
    assert workspace_watch._watch_task is None


# --- WebSocket route: subscribe/ping protocol + disconnect cleanup ---------

def test_ws_route_subscribe_ping_and_cleans_up_on_disconnect(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    from backend.app import app
    client = TestClient(app)

    assert workspace_watch._subscribers == []
    with client.websocket_connect("/api/workspace/watch") as ws:
        ws.send_json({"action": "subscribe", "paths": ["notes/a.md"]})
        ws.send_json({"action": "ping"})
        assert ws.receive_json() == {"type": "pong"}
        assert len(workspace_watch._subscribers) == 1
        assert workspace_watch._subscribers[0]["paths"] == {str(tmp_path / "notes" / "a.md")}

    assert workspace_watch._subscribers == []  # cleaned up on disconnect


def test_ws_route_unsubscribe_clears_path(tmp_path, monkeypatch):
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)
    from backend.app import app
    client = TestClient(app)

    with client.websocket_connect("/api/workspace/watch") as ws:
        ws.send_json({"action": "subscribe", "paths": ["notes/a.md"]})
        ws.send_json({"action": "unsubscribe", "paths": ["notes/a.md"]})
        ws.send_json({"action": "ping"})
        assert ws.receive_json() == {"type": "pong"}
        assert workspace_watch._subscribers[0]["paths"] == set()
