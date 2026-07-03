"""Promise store: state machine, idempotent completion, due detection, seed
round-trip. The store file resolves config.DATA_DIR at call time, so the
autouse _isolated_data_dir fixture isolates every test."""
import time

from backend import followup


def test_create_and_get_roundtrip():
    p = followup.create_promise("abc123", "agent:main:web-abc123", "render 566", 3600)
    assert p["state"] == "pending"
    assert p["label"] == "render 566"
    got = followup.get_promise(p["id"])
    assert got == p
    assert followup.get_promise("nope") is None


def test_record_completion_is_idempotent():
    p = followup.create_promise("abc123", "k", "render 566", 3600)
    assert followup.record_completion(p["id"], exit_code=0, duration_s=12.5, tail="ok") is True
    assert followup.record_completion(p["id"], exit_code=1, duration_s=99, tail="dupe") is False
    got = followup.get_promise(p["id"])
    assert got["exit_code"] == 0          # first ping wins
    assert got["state"] == "pending"      # completion recorded; turn not fired yet


def test_mark_only_transitions_from_pending():
    p = followup.create_promise("abc123", "k", "t", 3600)
    assert followup.mark(p["id"], "completed")["state"] == "completed"
    assert followup.mark(p["id"], "failed") is None    # terminal states stick


def test_due_promises_completion_and_deadline():
    now_ms = int(time.time() * 1000)
    done = followup.create_promise("a", "k1", "t1", 3600)
    followup.record_completion(done["id"], exit_code=0, duration_s=1, tail="")
    late = followup.create_promise("b", "k2", "t2", 1)          # 1s deadline
    fresh = followup.create_promise("c", "k3", "t3", 3600)
    nodeadline = followup.create_promise("d", "k4", "t4", 0)     # 0 = disabled
    due = dict(followup.due_promises(now_ms + 5_000))
    assert due[done["id"]] is False        # completion recorded → fire, not overdue
    assert due[late["id"]] is True         # past deadline, no ping → overdue
    assert fresh["id"] not in due
    assert nodeadline["id"] not in due


def test_seed_text_and_history_card():
    seed = followup.seed_text("render 566", exit_code=0, duration_s=754, tail="last line")
    assert seed.startswith("[[followup]]")
    assert "render 566" in seed and "exit 0" in seed and "last line" in seed
    card = followup.history_card(seed)
    assert card.startswith("⚙️ Background task · render 566")
    assert "exit 0" in card
    over = followup.seed_text("render 566", overdue=True)
    assert "never reported" in followup.history_card(over) or "no completion" in followup.history_card(over).lower()
    assert followup.history_card("hello Gary") is None
    assert followup.history_card(None) is None
