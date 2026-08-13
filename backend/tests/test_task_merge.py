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
