# backend/tests/test_steer_capability.py
import pathlib

from backend import capabilities, steer

ANCHORED = ("async function runClaudeLiveSessionTurn(params) {\n"
            "\t\tisStreaming: () => !replyBackendCompleted,\n"
            "\t\t/*CLI_STEER*/queueMessage: (text, options) => {}\n")
UNPATCHED = "async function runClaudeLiveSessionTurn(params) { isStreaming: () => 1 }\n"


def _dist(tmp_path, body, name="claude-live-session-Q1.js"):
    d = tmp_path / "dist"
    d.mkdir(exist_ok=True)
    (d / name).write_text(body, encoding="utf-8")
    return str(d)


def setup_function():
    steer.reset_cache()


def test_present_when_marker_in_live_session_file(tmp_path):
    assert steer.patch_present(_dist(tmp_path, ANCHORED)) is True


def test_absent_when_unpatched(tmp_path):
    assert steer.patch_present(_dist(tmp_path, UNPATCHED)) is False


def test_absent_when_file_renamed_but_still_found_by_needle(tmp_path):
    # a renamed bundle still counts as long as the function + marker are in it
    assert steer.patch_present(_dist(tmp_path, ANCHORED, name="zz-renamed.js")) is True


def test_absent_when_dist_missing(tmp_path):
    assert steer.patch_present(str(tmp_path / "nope")) is False


def test_non_utf8_sibling_is_skipped_not_fatal(tmp_path):
    # a binary file sorted before the real bundle must not crash the scan
    d = _dist(tmp_path, ANCHORED)
    (pathlib.Path(d) / "aaa-binary.js").write_bytes(b"\xff\xfe\x00garbage")
    assert steer.patch_present(d) is True


def test_capability_shape_and_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCLAW_DIST_DIR", _dist(tmp_path, UNPATCHED))
    cap = steer.capability()
    assert cap["available"] is False
    assert "patch" in cap["reason"]
    snap = capabilities.snapshot()
    assert snap["steer"] == cap


def test_session_can_steer():
    assert steer.session_can_steer({"endpoint_id": "claude-cli"}) is True
    assert steer.session_can_steer({"endpoint_id": "openai"}) is False
    assert steer.session_can_steer(None) is False
