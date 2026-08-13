import pytest

from backend import task_merge, task_registry


@pytest.fixture(autouse=True)
def clean():
    task_registry.reset_for_tests()
    task_merge.reset_for_tests()
    yield
    task_registry.reset_for_tests()
    task_merge.reset_for_tests()


def _observed(row_id="observed:200:20", subtree=(200, 300, 400),
              session_key="chat-1", state="running"):
    task_registry.upsert(row_id, kind="observed", source="observed",
                         label="bin/task run", session_key=session_key,
                         state=state,
                         extra={"pid": subtree[0], "subtree": list(subtree),
                                "observed": True})
    return row_id


def test_a_producer_pid_inside_the_chain_attaches_to_that_row():
    # The headline case. bin/task publishes the MIDDLE pid of its chain; pid
    # equality against the row's own pid (200) would match nothing.
    row = _observed()
    assert task_merge.target_for({"id": "x", "pid": 300}, "chat-1") == row


def test_the_chain_root_itself_also_attaches():
    row = _observed()
    assert task_merge.target_for({"id": "x", "pid": 200}, "chat-1") == row


def test_a_pid_in_no_chain_keeps_its_own_row():
    _observed()
    assert task_merge.target_for({"id": "x", "pid": 9999}, "chat-1") is None


def test_a_pidless_producer_attaches_by_session_when_one_row_matches():
    # The live pm-upload-rdup shape: bin/task start writes no pid at all.
    row = _observed()
    assert task_merge.target_for({"id": "x"}, "chat-1") == row


def test_a_pidless_producer_with_two_candidates_does_not_guess():
    _observed("observed:200:20")
    _observed("observed:500:50", subtree=(500,))
    assert task_merge.target_for({"id": "x"}, "chat-1") is None


def test_a_pidless_producer_from_another_session_does_not_attach():
    _observed(session_key="chat-1")
    assert task_merge.target_for({"id": "x"}, "chat-2") is None


def test_a_pidless_producer_with_no_session_does_not_attach():
    _observed()
    assert task_merge.target_for({"id": "x"}, None) is None


def test_a_terminal_observed_row_is_not_an_attach_candidate():
    _observed(state="done")
    assert task_merge.target_for({"id": "x", "pid": 300}, "chat-1") is None


def test_an_attachment_is_sticky_once_made():
    # The producer's pid exits (the chain collapses to its root) but the
    # producer keeps writing detail. It must keep talking to the same row.
    row = _observed()
    assert task_merge.target_for({"id": "x", "pid": 300}, "chat-1") == row
    task_registry.upsert(row, kind="observed", source="observed", state="running",
                         extra={"pid": 200, "subtree": [200], "observed": True})
    assert task_merge.target_for({"id": "x", "pid": 300}, "chat-1") == row


def test_an_attached_producer_does_not_impose_a_running_state():
    row = _observed()
    task_merge.target_for({"id": "x", "pid": 300}, "chat-1")
    assert task_merge.state_for({"id": "x", "status": "running"}, row) is None


def test_an_attached_producers_own_terminal_word_does_apply():
    row = _observed()
    task_merge.target_for({"id": "x", "pid": 300}, "chat-1")
    assert task_merge.state_for({"id": "x", "status": "completed"}, row) == "done"
    assert task_merge.state_for({"id": "x", "status": "error"}, row) == "failed"


# --- Review round 1: a stale binding must not survive its row going terminal
#
# `--id nightly` (a stable, caller-chosen producer id) is the real shape on
# this box. A finished row is retained by task_registry for RETAIN_TERMINAL_S
# (900s), so `task_registry.get(bound)` keeps returning it long after it
# closed. Without this fix a second run reusing the same id would attach to
# the FIRST run's now-finished row instead of the fresh live one the observer
# created for it.


def test_a_bound_producer_re_derives_after_its_row_goes_terminal():
    row_a = _observed("observed:200:20", subtree=(200,))
    assert task_merge.target_for({"id": "nightly", "pid": 200}, "chat-1") == row_a
    task_registry.upsert(row_a, kind="observed", source="observed", state="done",
                         extra={"pid": 200, "subtree": [200], "observed": True})
    row_b = _observed("observed:500:50", subtree=(500,))
    # Same producer id, same session, but a NEW live row — the stale binding
    # to the finished row must be dropped, not honored.
    assert task_merge.target_for({"id": "nightly", "pid": 500}, "chat-1") == row_b


def test_a_bound_producers_own_terminal_word_still_reaches_its_finished_row():
    # The other half of the same fix: a producer's OWN final word must still
    # land on the row it actually ran with, even a beat after that row
    # already closed (e.g. the observer got there first).
    row = _observed()
    assert task_merge.target_for({"id": "x", "pid": 300}, "chat-1") == row
    task_registry.upsert(row, kind="observed", source="observed", state="done",
                         extra={"pid": 200, "subtree": [200, 300, 400], "observed": True})
    assert task_merge.target_for({"id": "x", "pid": 300, "status": "completed"},
                                 "chat-1") == row


# --- Review round 1: attachment strength must follow evidence quality -----
#
# "Exactly one live observed row in this chat" is only the absence of a
# second candidate, not proof this producer IS that row's job. A pid found in
# the row's subtree is proof. Only the pid-proven kind may declare the row's
# outcome.


def test_only_a_pid_proven_attach_may_impose_a_terminal_state():
    row_pid = _observed("observed:200:20", subtree=(200, 300))
    row_session = _observed("observed:600:60", subtree=(600,), session_key="chat-2")
    assert task_merge.target_for({"id": "p", "pid": 300}, "chat-1") == row_pid
    assert task_merge.target_for({"id": "s"}, "chat-2") == row_session
    assert task_merge.state_for({"id": "p", "status": "completed"}, row_pid) == "done"
    assert task_merge.state_for({"id": "s", "status": "completed"}, row_session) is None


def test_attach_method_reports_which_evidence_bound_the_producer():
    row_pid = _observed("observed:200:20", subtree=(200, 300))
    row_session = _observed("observed:600:60", subtree=(600,), session_key="chat-2")
    task_merge.target_for({"id": "p", "pid": 300}, "chat-1")
    task_merge.target_for({"id": "s"}, "chat-2")
    assert task_merge.attach_method({"id": "p"}, row_pid) == "pid"
    assert task_merge.attach_method({"id": "s"}, row_session) == "session"
    assert task_merge.attach_method({"id": "unbound"}, row_pid) is None
