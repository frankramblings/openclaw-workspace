import os
import shutil
import subprocess

import pytest

from backend import config, shell_hook


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    return tmp_path


def test_parse_pairs_a_foreground_command_with_its_exit_code():
    # Spike shape A, verbatim from the harness log.
    text = ("start\t1786592559.061192\t3866560\t\t/bin/task run -- bash -c 'sleep 16'\n"
            "end\t1786592575.135103\t3866560\t\t0\n")
    (cmd,) = shell_hook.parse(text)
    assert cmd["text"] == "/bin/task run -- bash -c 'sleep 16'"
    assert cmd["start"] == 1786592559.061192
    assert cmd["end"] == 1786592575.135103
    assert cmd["exit_code"] == 0
    assert cmd["bg_pid"] is None
    assert cmd["outcome_known"] is True


def test_a_background_launch_reports_its_pid_and_disowns_its_exit_code():
    # Spike shape B: the envelope closed 1.1ms after opening, exit 0, for a job
    # that ran 18s. $! CHANGED, so the pid is this command's and the exit code
    # describes the fork rather than the work.
    text = ("start\t100.0\t500\t\tnohup bash -c 'sleep 18' &\n"
            "end\t100.0011\t500\t3866704\t0\n")
    (cmd,) = shell_hook.parse(text)
    assert cmd["bg_pid"] == 3866704
    assert cmd["exit_code"] == 0
    assert cmd["outcome_known"] is False


def test_a_stale_bang_is_never_reported_as_this_commands_pid():
    # Spike shape C, immediately after shape B: $! still holds B's pid.
    # Reporting it would bind C's row to an unrelated process and kill the row
    # when B finishes.
    text = ("start\t200.0\t500\t3866704\tsystemd-run --user --unit=x sleep 18\n"
            "end\t200.0157\t500\t3866704\t0\n")
    (cmd,) = shell_hook.parse(text)
    assert cmd["bg_pid"] is None
    assert cmd["outcome_known"] is True


def test_a_nonzero_exit_code_is_kept():
    text = "start\t1.0\t5\t\tfalse\nend\t1.1\t5\t\t1\n"
    (cmd,) = shell_hook.parse(text)
    assert cmd["exit_code"] == 1


def test_command_text_may_contain_tabs():
    text = "start\t1.0\t5\t\tgrep -P '\\t' file\nend\t1.2\t5\t\t0\n"
    (cmd,) = shell_hook.parse(text)
    assert cmd["text"] == "grep -P '\\t' file"


def test_an_unclosed_command_has_no_end_and_no_outcome():
    text = "start\t1.0\t5\t\tsleep 600\n"
    (cmd,) = shell_hook.parse(text)
    assert cmd["end"] is None
    assert cmd["exit_code"] is None
    assert cmd["outcome_known"] is False


def test_a_trailing_partial_line_is_ignored():
    # The observer tails a file a shell is actively appending to.
    text = "start\t1.0\t5\t\tsleep 600\nend\t1.5\t5\t\t0\nstart\t2.0\t5"
    assert len(shell_hook.parse(text)) == 1


def test_garbage_lines_do_not_break_the_parse():
    text = "not a hook line\nstart\t1.0\t5\t\tls\nend\t1.1\t5\t\t0\n"
    assert len(shell_hook.parse(text)) == 1


def test_rc_sources_the_users_bashrc_before_installing_the_hooks(data_dir):
    body = shell_hook.write_rc("sess-1").read_text()
    assert body.index(".bashrc") < body.index("trap '__hp_start' DEBUG")
    # The DEBUG trap is installed LAST so the PROMPT_COMMAND assignment itself
    # does not fire it and log a phantom command.
    assert body.index("PROMPT_COMMAND=") < body.index("trap '__hp_start' DEBUG")


def test_rc_preserves_an_existing_prompt_command(data_dir):
    body = shell_hook.write_rc("sess-1").read_text()
    assert '${PROMPT_COMMAND:+; $PROMPT_COMMAND}' in body


def test_paths_are_per_session_and_filesystem_safe(data_dir):
    a = shell_hook.log_path("agent:main:web-abc")
    b = shell_hook.log_path("agent:main:web-xyz")
    assert a != b
    assert ":" not in a.name and "/" not in a.name


def test_read_new_returns_only_what_was_appended(data_dir):
    p = data_dir / "hook.log"
    p.write_text("one\n")
    text, offset = shell_hook.read_new(p, 0)
    assert text == "one\n" and offset == 4
    with p.open("a") as f:
        f.write("two\n")
    text, offset = shell_hook.read_new(p, offset)
    assert text == "two\n" and offset == 8


def test_read_new_on_a_missing_file_is_empty(data_dir):
    assert shell_hook.read_new(data_dir / "nope.log", 0) == ("", 0)


def test_read_new_restarts_when_the_file_was_truncated(data_dir):
    p = data_dir / "hook.log"
    p.write_text("aaaaaaaa\n")
    _text, offset = shell_hook.read_new(p, 0)
    p.write_text("b\n")
    text, new_offset = shell_hook.read_new(p, offset)
    assert text == "b\n" and new_offset == 2


# --- Final review, Important 5: the log is bounded at both ends -----------
#
# Nothing rotated or deleted these logs, and the DEBUG trap appends two lines
# per top-level command, so an ordinary shell loop writes hundreds of
# thousands of lines. Worse than the disk cost: a cold backend process asks
# read_new for offset 0, which used to f.read() the WHOLE file inside the
# event-loop thread and then keep only its last 64 KB.


def test_write_rc_truncates_an_existing_log(data_dir):
    log = shell_hook.log_path("sess-trunc")
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text("start\t1.0\t5\t\tfrom a previous shell\n" * 1000)
    shell_hook.write_rc("sess-trunc")
    assert log.read_bytes() == b""


def test_write_rc_still_returns_the_rc_when_the_log_cannot_be_truncated(
        data_dir, monkeypatch):
    # A hook is worth having even if the log won't truncate — the reader is
    # capped anyway. Losing the session's hook over it would not be.
    def boom(_key):
        raise OSError("read-only")

    monkeypatch.setattr(shell_hook, "log_path", boom)
    assert shell_hook.write_rc("sess-ro").read_text() == shell_hook.RC_TEMPLATE


def test_a_cold_read_of_a_huge_log_returns_only_its_tail(data_dir):
    p = data_dir / "huge.log"
    line = "start\t1.0\t5\t\t" + "x" * 100 + "\n"
    body = line * 4000                     # ~460 KB, well past the cap
    p.write_text(body)
    size = p.stat().st_size
    text, offset = shell_hook.read_new(p, 0)
    assert len(text.encode()) == shell_hook.TAIL_MAX_BYTES
    # The offset the caller stores must describe what was actually read: the
    # end of the file, not the end of a read that started at zero.
    assert offset == size
    assert text == body[-shell_hook.TAIL_MAX_BYTES:]


def test_a_tail_read_still_tracks_later_appends(data_dir):
    p = data_dir / "huge2.log"
    p.write_text("y" * (shell_hook.TAIL_MAX_BYTES + 5000))
    _text, offset = shell_hook.read_new(p, 0)
    with p.open("a") as f:
        f.write("end\t1.1\t5\t\t0\n")
    text, new_offset = shell_hook.read_new(p, offset)
    assert text == "end\t1.1\t5\t\t0\n"
    assert new_offset == p.stat().st_size


def test_a_cold_read_under_the_cap_is_unchanged(data_dir):
    p = data_dir / "small.log"
    p.write_text("start\t1.0\t5\t\tls\n")
    assert shell_hook.read_new(p, 0) == ("start\t1.0\t5\t\tls\n", p.stat().st_size)


@pytest.mark.skipif(not shutil.which("bash"), reason="bash required")
def test_a_real_bash_writes_a_parseable_envelope(data_dir, tmp_path):
    # The end-to-end proof: a real interactive bash, the real rcfile, a real
    # command. bash -i on a pipe still runs PROMPT_COMMAND, so no pty needed.
    rc = shell_hook.write_rc("real")
    log = shell_hook.log_path("real")
    subprocess.run(["bash", "--rcfile", str(rc), "-i"],
                   input="sleep 0.2\nexit\n", text=True, timeout=30,
                   env={**os.environ, "HP_LOG": str(log)},
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cmds = [c for c in shell_hook.parse(log.read_text()) if "sleep 0.2" in c["text"]]
    assert len(cmds) == 1
    assert cmds[0]["exit_code"] == 0
    assert cmds[0]["end"] - cmds[0]["start"] >= 0.15
    assert cmds[0]["outcome_known"] is True
