import pytest

from backend import config, shell_hook, terminals


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "OBSERVER_ENABLED", True)
    return tmp_path


def test_bash_gets_the_generated_rcfile_and_the_log_env(data_dir):
    argv, env = terminals._hook_argv_env("/bin/bash", "sess-1", ["/bin/bash", "-i"], {})
    assert argv == ["/bin/bash", "--rcfile", str(shell_hook.rc_path("sess-1")), "-i"]
    assert env["HP_LOG"] == str(shell_hook.log_path("sess-1"))
    assert shell_hook.rc_path("sess-1").is_file()


def test_a_non_bash_shell_is_left_alone(data_dir):
    argv, env = terminals._hook_argv_env("/usr/bin/zsh", "sess-1", ["/usr/bin/zsh", "-i"], {})
    assert argv == ["/usr/bin/zsh", "-i"]
    assert "HP_LOG" not in env


def test_the_hook_is_skipped_when_the_observer_is_off(data_dir, monkeypatch):
    monkeypatch.setattr(config, "OBSERVER_ENABLED", False)
    argv, env = terminals._hook_argv_env("/bin/bash", "sess-1", ["/bin/bash", "-i"], {})
    assert argv == ["/bin/bash", "-i"]
    assert "HP_LOG" not in env


def test_an_unwritable_rc_degrades_to_a_plain_shell(data_dir, monkeypatch):
    # Degraded coverage, never a broken terminal: the user's shell must start.
    def boom(_key):
        raise OSError("read-only filesystem")
    monkeypatch.setattr(shell_hook, "write_rc", boom)
    argv, env = terminals._hook_argv_env("/bin/bash", "sess-1", ["/bin/bash", "-i"], {})
    assert argv == ["/bin/bash", "-i"]
    assert "HP_LOG" not in env


def test_live_shells_reports_running_sessions_only(monkeypatch):
    class FakeSession:
        def __init__(self, pid, exited):
            self.pid = pid
            self.exited = exited

    monkeypatch.setattr(terminals, "_sessions",
                        {"a": FakeSession(101, False),
                         "b": FakeSession(202, True),
                         "c": FakeSession(None, False)})
    assert terminals.live_shells() == {"a": 101}
