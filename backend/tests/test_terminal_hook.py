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
    def boom(_key, _shell="bash"):
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


def test_fish_takes_its_rc_by_init_command(data_dir):
    # fish has no --rcfile; --init-command is evaluated after config.fish,
    # which is the same "your environment first" contract bash gets.
    argv, env = terminals._hook_argv_env(
        "/usr/bin/fish", "sess-1", ["/usr/bin/fish", "-i"], {})
    rc = shell_hook.rc_path("sess-1", "fish")
    assert argv == ["/usr/bin/fish", "--init-command", f"source '{rc}'", "-i"]
    assert env["HP_LOG"] == str(shell_hook.log_path("sess-1"))
    assert rc.is_file()


def test_fish_and_bash_write_different_rc_files(data_dir):
    terminals._hook_argv_env("/bin/bash", "sess-1", ["/bin/bash", "-i"], {})
    terminals._hook_argv_env("/usr/bin/fish", "sess-1", ["/usr/bin/fish", "-i"], {})
    assert shell_hook.rc_path("sess-1", "bash").is_file()
    assert shell_hook.rc_path("sess-1", "fish").is_file()
    assert "--on-event fish_preexec" not in shell_hook.rc_path("sess-1", "bash").read_text()
    assert "PROMPT_COMMAND" not in shell_hook.rc_path("sess-1", "fish").read_text()


def test_a_fish_rc_path_with_a_space_is_quoted_for_fish(data_dir, monkeypatch, tmp_path):
    spaced = tmp_path / "two words"
    monkeypatch.setattr(config, "DATA_DIR", spaced)
    argv, _env = terminals._hook_argv_env(
        "/usr/bin/fish", "sess-1", ["/usr/bin/fish", "-i"], {})
    init = argv[argv.index("--init-command") + 1]
    assert init.startswith("source '") and init.endswith("'")
    assert "two words" in init
