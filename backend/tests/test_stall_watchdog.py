"""Stall watchdog: pure helpers + relay loop + stream_turn retry orchestration."""
import asyncio
import json

import pytest

from backend import bridge, config


# --- pure helpers ---------------------------------------------------------------

def test_is_run_activity_matches_own_run():
    assert bridge._is_run_activity({"runId": "r1"}, "r1")
    assert not bridge._is_run_activity({"runId": "other"}, "r1")


def test_is_run_activity_counts_codex_runtime_metadata():
    # codex_app_server.* streams are runtime-level liveness (mid-turn compaction
    # keeps emitting these) regardless of runId.
    assert bridge._is_run_activity({"stream": "codex_app_server.status"}, "r1")
    assert not bridge._is_run_activity({"stream": "lifecycle"}, "r1")
    assert not bridge._is_run_activity({}, "r1")


def test_stall_action_thresholds(monkeypatch):
    monkeypatch.setattr(config, "STALL_NOTICE_S", 45.0)
    monkeypatch.setattr(config, "STALL_CAP_S", 240.0)
    assert bridge._stall_action(10.0) is None
    assert bridge._stall_action(45.0) == "notice"
    assert bridge._stall_action(239.9) == "notice"
    assert bridge._stall_action(240.0) == "cap"
