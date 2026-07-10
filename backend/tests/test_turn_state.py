"""turn_state: the durable in-flight/interrupted turn ledger. A restart must
turn 'in flight' into 'interrupted' (sweep_boot), ids must be monotonic across
sessions, and a corrupt store must be quarantined — never rebuilt-empty over
the original bytes (see fsutil.load_json_guarded)."""
from backend import config, turn_state


def test_ids_are_monotonic_across_sessions():
    a = turn_state.turn_started("agent:main:web-aaa")
    b = turn_state.turn_started("agent:main:web-bbb")
    assert b == a + 1


def test_normal_lifecycle_leaves_nothing_behind():
    key = "agent:main:web-ccc"
    turn_state.turn_started(key)
    assert turn_state.inflight_for(key) is not None
    turn_state.turn_ended(key)
    assert turn_state.inflight_for(key) is None
    assert turn_state.interrupted_for(key) is None
    assert turn_state.sweep_boot() == {}


def test_boot_sweep_marks_interrupted():
    key = "agent:main:web-ddd"
    tid = turn_state.turn_started(key)
    moved = turn_state.sweep_boot()
    assert key in moved
    rec = turn_state.interrupted_for(key)
    assert rec["turn_id"] == tid
    assert rec["detected"] >= rec["started"]
    assert turn_state.inflight_for(key) is None


def test_next_turn_clears_interrupted_marker():
    key = "agent:main:web-eee"
    turn_state.turn_started(key)
    turn_state.sweep_boot()
    assert turn_state.interrupted_for(key) is not None
    turn_state.turn_started(key)
    assert turn_state.interrupted_for(key) is None


def test_ids_survive_restart_simulation():
    # Same store file across "restarts" (module state is on disk, not in RAM).
    a = turn_state.turn_started("agent:main:web-fff")
    turn_state.turn_ended("agent:main:web-fff")
    b = turn_state.turn_started("agent:main:web-ggg")
    assert b == a + 1  # counter persisted, no reuse after the first turn ended


def test_corrupt_store_is_quarantined_not_fatal(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    store = tmp_path / "turns_inflight.json"
    tmp_path.mkdir(parents=True, exist_ok=True)
    store.write_text("{this is not json", encoding="utf-8")
    assert turn_state.turn_started("agent:main:web-hhh") == 1
    assert list(tmp_path.glob("turns_inflight.json.corrupt-*")), \
        "corrupt store must be renamed aside, not overwritten"
