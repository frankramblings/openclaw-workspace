"""The claude-cli steer gateway patch: applies exactly once, is idempotent,
and no-ops loudly when the bundle shape changed."""
import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "gateway-patches" / "claude-cli-steer.py"

ANCHOR = (
    "\tlet replyBackendCompleted = false;\n"
    "\tconst replyBackendHandle = params.context.params.replyOperation ? {\n"
    "\t\tkind: \"cli\",\n"
    "\t\tcancel: abort,\n"
    "\t\tisStreaming: () => !replyBackendCompleted\n"
    "\t} : void 0;\n"
)
FIXTURE = "async function runClaudeLiveSessionTurn(params) {\n" + ANCHOR + "}\n"


def _load():
    spec = importlib.util.spec_from_file_location("claude_cli_steer", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _dist(tmp_path, body=FIXTURE, name="claude-live-session-AbC123.js"):
    d = tmp_path / "dist"
    d.mkdir()
    (d / name).write_text(body, encoding="utf-8")
    (d / "other-XyZ.js").write_text("function unrelated() {}\n", encoding="utf-8")
    return d


def test_applies_once_and_marks(tmp_path):
    mod = _load()
    d = _dist(tmp_path)
    assert mod.apply(str(d)) == 0
    out = (d / "claude-live-session-AbC123.js").read_text(encoding="utf-8")
    assert out.count(mod.MARKER) == 1
    assert "queueMessage: (text, options) =>" in out
    assert "writeTurnInput(liveSession, String(text))" in out
    assert "persistApproved" in out
    # the original handle fields survive
    assert "kind: \"cli\"" in out and "cancel: abort" in out
    # never throws synchronously: the guard produces a rejected promise
    assert "Promise.reject(new Error(" in out


def test_idempotent_second_run(tmp_path):
    mod = _load()
    d = _dist(tmp_path)
    mod.apply(str(d))
    before = (d / "claude-live-session-AbC123.js").read_text(encoding="utf-8")
    assert mod.apply(str(d)) == 0
    after = (d / "claude-live-session-AbC123.js").read_text(encoding="utf-8")
    assert before == after


def test_missing_anchor_is_a_noop_with_exit_zero(tmp_path, capsys):
    mod = _load()
    d = _dist(tmp_path, body="async function runClaudeLiveSessionTurn(params) { /* reshaped */ }\n")
    assert mod.apply(str(d)) == 0
    assert "WARN" in capsys.readouterr().err
    assert mod.MARKER not in (d / "claude-live-session-AbC123.js").read_text(encoding="utf-8")


def test_two_anchors_refuses(tmp_path, capsys):
    mod = _load()
    d = _dist(tmp_path, body=FIXTURE + FIXTURE)
    assert mod.apply(str(d)) == 0
    assert "expected 1 patch target, found 2" in capsys.readouterr().err


def test_missing_dist_dir_is_noop(tmp_path):
    mod = _load()
    assert mod.apply(str(tmp_path / "nope")) == 0
