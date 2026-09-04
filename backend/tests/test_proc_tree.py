import os

from backend import proc_tree


def _procs(*rows):
    return {pid: {"ppid": ppid, "starttime": st, "cmdline": cmd}
            for pid, ppid, st, cmd in rows}


# The spike's shape A: `bin/task run -- bash -c 'sleep 16'` under shell 100.
SHAPE_A = _procs(
    (100, 1, 10, "bash -i"),
    (200, 100, 20, "python3 /srv/agent/bin/task run --id x"),
    (300, 200, 30, "bash -c sleep 16; echo done"),
    (400, 300, 40, "sleep 16"),
    (900, 1, 90, "some unrelated daemon"),
)


def test_descendants_walks_the_whole_subtree():
    assert proc_tree.descendants(SHAPE_A, 100) == {200, 300, 400}


def test_descendants_of_an_unknown_pid_is_empty():
    assert proc_tree.descendants(SHAPE_A, 12345) == set()


def test_chains_collapses_one_job_into_one_entry():
    # Three live processes, one job. The row keys on 200 (the shell's direct
    # child) — not on 300, which is the pid `bin/task` publishes, and not on
    # all three, which is the three-rows-for-one-render bug.
    assert proc_tree.chains(SHAPE_A, 100) == {200: {200, 300, 400}}


def test_chains_keeps_sibling_jobs_apart():
    procs = _procs(
        (100, 1, 10, "bash -i"),
        (200, 100, 20, "ffmpeg -i a.mov"),
        (210, 200, 21, "ffmpeg worker"),
        (300, 100, 30, "rsync -a /src /dst"),
    )
    assert proc_tree.chains(procs, 100) == {200: {200, 210}, 300: {300}}


def test_chains_of_a_shell_with_no_children_is_empty():
    assert proc_tree.chains(_procs((100, 1, 10, "bash -i")), 100) == {}


def test_key_for_pairs_pid_with_starttime():
    # starttime is what makes the key survive pid recycling.
    assert proc_tree.key_for(200, SHAPE_A) == "200:20"


def test_key_for_an_unknown_pid_still_returns_a_key():
    assert proc_tree.key_for(777, SHAPE_A) == "777:0"


def test_snapshot_sees_this_very_process():
    procs = proc_tree.snapshot()
    me = os.getpid()
    assert me in procs
    assert procs[me]["ppid"] == os.getppid()
    assert procs[me]["starttime"] > 0


def test_read_proc_of_a_pid_that_cannot_exist_is_none():
    # A process that exits mid-walk is the normal case, not an error: snapshot
    # skips it rather than raising and losing every other row in the pass.
    assert proc_tree.read_proc(2 ** 30) is None
