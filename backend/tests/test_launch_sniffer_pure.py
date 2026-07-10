"""The sniffer's pure half: which tool_start frames even qualify. Patterns are
deliberately conservative — a missed launch costs nothing new (status quo),
a false positive registers a harmless watched promise whose worst case is one honest deadline turn."""
import pytest

from backend import launch_sniffer, task_registry


@pytest.fixture(autouse=True)
def _fresh():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


@pytest.mark.parametrize("cmd", [
    "nohup ./render.sh out.mp4 &",
    "nohup python train.py",
    "setsid ./worker --queue jobs",
    "cd /tmp && nohup make -j8 &",
    "./server --port 8080 &",
    "long_job --input data.csv & disown",
    "screen -dmS render ./render.sh",
    "tmux new-session -d ./batch.sh",
    "tmux new -d 'python x.py'",
])
def test_background_launches_detected(cmd):
    assert launch_sniffer.looks_background(cmd) is True


@pytest.mark.parametrize("cmd", [
    "ls -la",
    "grep -rn 'cats & dogs' src/",          # & mid-string, not trailing
    "make && make test",                     # && is sequencing, not background
    "echo 'use nohup for long jobs'",        # quoted advice… tolerated FP? no:
])
def test_foreground_commands_ignored(cmd):
    # NOTE: the echo case IS a false positive for the \bnohup\s pattern unless
    # patterns require nohup at a command position. The patterns below anchor
    # to start/separator, and "echo 'use nohup" has nohup after a quote —
    # accepted as NOT matching because the token before it is 'use, not a
    # separator. If this test fails, tighten the pattern, don't delete the case.
    assert launch_sniffer.looks_background(cmd) is False


def test_exec_tool_gate():
    assert launch_sniffer.is_exec_tool("Bash") is True
    assert launch_sniffer.is_exec_tool("bash") is True
    assert launch_sniffer.is_exec_tool("local_shell") is True
    assert launch_sniffer.is_exec_tool("TodoWrite") is False
    assert launch_sniffer.is_exec_tool(None) is False
    assert launch_sniffer.is_exec_tool("weird", item_is_command=True) is True


def test_core_command_strips_tokens():
    core = launch_sniffer.core_command("nohup ./render.sh out.mp4 &")
    assert core == "./render.sh out.mp4"
    assert len(launch_sniffer.core_command("setsid " + "x" * 300)) <= 80


def test_has_session_registration_since():
    sk = "agent:main:web-abc123def456"
    assert task_registry.has_session_registration_since(sk, 0) is False
    task_registry.upsert("followup:a1", kind="auto", source="followup",
                         session_key=sk)
    assert task_registry.has_session_registration_since(sk, 0) is False  # auto excluded
    task_registry.upsert("followup:b2", kind="followup", source="followup",
                         session_key=sk)
    assert task_registry.has_session_registration_since(sk, 0) is True
    future = task_registry.get("followup:b2")["created"] + 1
    assert task_registry.has_session_registration_since(sk, future) is False
