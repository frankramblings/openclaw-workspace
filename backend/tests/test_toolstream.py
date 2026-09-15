"""Live tail of a running Bash tool call (/api/toolstream/<tool_id>).

The gateway reports a tool call only at start and at completion, so the PWA
polls this route to show output while a long command is still running. The
behaviour that matters here: partial lines are never served early (they'd
render as a torn line and then be lost), a missing log reads as "nothing yet"
rather than an error, and the id can't be used to walk out of the log dir.
"""
import pytest
from fastapi.testclient import TestClient

from backend import toolstream
from backend.app import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _log_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(toolstream, "log_dir", lambda: tmp_path)
    return tmp_path


def write(dirpath, tool_id, text):
    p = dirpath / f"{tool_id}.log"
    p.write_text(text, encoding="utf-8")
    return p


def test_missing_log_is_not_an_error(client):
    r = client.get("/api/toolstream/toolu_missing")
    assert r.status_code == 200
    assert r.json() == {"lines": [], "offset": 0, "available": False}


def test_serves_complete_lines_and_reports_a_resumable_offset(client, _log_dir):
    write(_log_dir, "toolu_a", "tick 1\ntick 2\n")
    body = client.get("/api/toolstream/toolu_a").json()
    assert body["lines"] == ["tick 1", "tick 2"]
    assert body["available"] is True
    assert body["offset"] == len("tick 1\ntick 2\n")


def test_a_half_written_line_is_withheld_until_it_is_complete(client, _log_dir):
    # A command mid-write: "tick 2" has no newline yet. Serving it now would
    # render a torn line AND consume it, so the rest would never arrive.
    write(_log_dir, "toolu_b", "tick 1\ntick 2")
    first = client.get("/api/toolstream/toolu_b").json()
    assert first["lines"] == ["tick 1"]
    assert first["offset"] == len("tick 1\n")

    write(_log_dir, "toolu_b", "tick 1\ntick 2\n")
    second = client.get(f"/api/toolstream/toolu_b?offset={first['offset']}").json()
    assert second["lines"] == ["tick 2"], "the withheld line arrives whole on the next poll"


def test_polling_from_an_offset_returns_only_what_is_new(client, _log_dir):
    write(_log_dir, "toolu_c", "a\nb\n")
    first = client.get("/api/toolstream/toolu_c").json()
    write(_log_dir, "toolu_c", "a\nb\nc\n")
    second = client.get(f"/api/toolstream/toolu_c?offset={first['offset']}").json()
    assert second["lines"] == ["c"]


def test_an_offset_past_a_reaped_log_restarts_instead_of_serving_garbage(client, _log_dir):
    write(_log_dir, "toolu_d", "short\n")
    body = client.get("/api/toolstream/toolu_d?offset=99999").json()
    assert body["lines"] == ["short"]


def test_a_flood_is_capped_and_says_so(client, _log_dir):
    write(_log_dir, "toolu_e", "".join(f"L{i}\n" for i in range(toolstream.MAX_LINES + 50)))
    body = client.get("/api/toolstream/toolu_e").json()
    assert len(body["lines"]) == toolstream.MAX_LINES
    assert body["omitted"] == 50
    assert body["lines"][-1] == f"L{toolstream.MAX_LINES + 49}", "keeps the newest output"


@pytest.mark.parametrize("bad", ["../secret", "a/b", "a.b", ""])
def test_a_traversing_id_is_rejected(client, bad):
    r = client.get(f"/api/toolstream/{bad}")
    assert r.status_code in (400, 404), f"{bad!r} must not resolve to a file"


def test_invalid_utf8_in_a_partial_line_does_not_skew_the_offset(client, _log_dir):
    # A lone 0xFF re-encodes as a 3-byte replacement char. Measuring the
    # withheld fragment by re-encoding would under-count consumed bytes.
    p = _log_dir / "toolu_f.log"
    p.write_bytes(b"ok\n\xffpart")
    first = client.get("/api/toolstream/toolu_f").json()
    assert first["lines"] == ["ok"]
    assert first["offset"] == len(b"ok\n")
    p.write_bytes(b"ok\n\xffpart done\n")
    second = client.get(f"/api/toolstream/toolu_f?offset={first['offset']}").json()
    assert second["lines"] == ["�part done"]
