"""Per-session terminal image attachment registry: register/list/resolve/consume."""
import pytest

from backend import terminals


@pytest.fixture(autouse=True)
def _isolate_registry(tmp_path, monkeypatch):
    # Point the registry dir at a temp dir so tests never touch real .data.
    monkeypatch.setattr(terminals.config, "DATA_DIR", tmp_path, raising=False)


def test_register_returns_bracketed_token_from_name():
    tok = terminals.register_attachment("k1", "ab12cd34.png", name="gary.png", mime="image/png")
    assert tok == "[gary.png]"


def test_register_collision_suffixes():
    t1 = terminals.register_attachment("k2", "aaaa.png", name="gary.png", mime="image/png")
    t2 = terminals.register_attachment("k2", "bbbb.png", name="gary.png", mime="image/png")
    assert t1 == "[gary.png]"
    assert t2 == "[gary-2.png]"


def test_register_clipboard_no_name_uses_pasted():
    t1 = terminals.register_attachment("k3", "cccc.png", name=None, mime="image/png")
    t2 = terminals.register_attachment("k3", "dddd.png", name="", mime="image/png")
    assert t1 == "[pasted-1.png]"
    assert t2 == "[pasted-2.png]"


def test_resolve_with_and_without_brackets():
    terminals.register_attachment("k4", "eeee.png", name="x.png", mime="image/png")
    p = terminals.resolve_attachment("k4", "[x.png]")
    assert p and p.endswith("/.attachments/eeee.png")
    assert terminals.resolve_attachment("k4", "x.png") == p
    assert terminals.resolve_attachment("k4", "missing.png") is None


def test_list_and_mark_consumed():
    terminals.register_attachment("k5", "ffff.png", name="a.png", mime="image/png")
    terminals.register_attachment("k5", "gggg.png", name="b.png", mime="image/png")
    assert len(terminals.list_attachments("k5", pending_only=True)) == 2
    terminals.mark_consumed("k5", ["[a.png]"])
    pend = terminals.list_attachments("k5", pending_only=True)
    assert [it["token"] for it in pend] == ["[b.png]"]
    assert len(terminals.list_attachments("k5")) == 2  # mapping persists


def test_close_session_clears_registry():
    terminals.register_attachment("k6", "hhhh.png", name="c.png", mime="image/png")
    assert terminals._attachments_path("k6").exists()
    terminals.close_session("k6")
    assert not terminals._attachments_path("k6").exists()


# --- HTTP route tests ---------------------------------------------------------

from fastapi.testclient import TestClient  # noqa: E402 - intentionally scoped to this section (house style)

from backend.app import app  # noqa: E402 - intentionally scoped to this section (house style)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "0")
    return TestClient(app)


def test_attach_route_returns_token(client):
    r = client.post("/api/terminal/routekey/attach",
                    json={"file_id": "zz11.png", "name": "shot.png", "mime": "image/png"})
    assert r.status_code == 200
    assert r.json()["token"] == "[shot.png]"


def test_attach_requires_file_id(client):
    r = client.post("/api/terminal/routekey/attach", json={"name": "x.png"})
    assert r.status_code == 400


def test_attachments_list_pending_filter(client):
    client.post("/api/terminal/listkey/attach", json={"file_id": "a1.png", "name": "a.png"})
    terminals.mark_consumed("listkey", ["[a.png]"])
    client.post("/api/terminal/listkey/attach", json={"file_id": "b1.png", "name": "b.png"})
    all_ = client.get("/api/terminal/listkey/attachments").json()["attachments"]
    pend = client.get("/api/terminal/listkey/attachments?pending=1").json()["attachments"]
    assert len(all_) == 2
    assert [it["token"] for it in pend] == ["[b.png]"]


def test_resolve_route(client):
    client.post("/api/terminal/reskey/attach", json={"file_id": "c1.png", "name": "c.png"})
    ok = client.get("/api/terminal/reskey/resolve", params={"token": "[c.png]"})
    assert ok.status_code == 200 and ok.json()["path"].endswith("/.attachments/c1.png")
    miss = client.get("/api/terminal/reskey/resolve", params={"token": "[nope.png]"})
    assert miss.status_code == 404


def test_attachment_note_lists_tokens_and_strips():
    terminals.register_attachment("notek", "ii.png", name="gary.png", mime="image/png")
    note = terminals.terminal_attachment_note("notek")
    assert note.startswith(terminals._ATTACH_NOTE_PREFIX)
    assert "[gary.png]" in note and note.endswith("\n\n")
    msg = note + "hello user"
    assert terminals.strip_capability_note(msg) == "hello user"


def test_attachment_note_empty_when_none():
    assert terminals.terminal_attachment_note("emptyk") == ""


def test_strip_handles_both_leading_blocks(monkeypatch):
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    cap = terminals.gary_capability_note("bothk")
    terminals.register_attachment("bothk", "jj.png", name="z.png", mime="image/png")
    att = terminals.terminal_attachment_note("bothk")
    assert terminals.strip_capability_note(cap + att + "BODY") == "BODY"


# --- Fix 1: path-traversal validation ----------------------------------------

def test_register_rejects_path_traversal():
    """file_id with .. components must raise ValueError."""
    with pytest.raises(ValueError, match="invalid file_id"):
        terminals.register_attachment("sec1", "../../etc/passwd", name="x.png")


def test_register_rejects_subdir_file_id():
    """file_id with a subdirectory component must raise ValueError."""
    with pytest.raises(ValueError, match="invalid file_id"):
        terminals.register_attachment("sec2", "a/b.png", name="b.png")


def test_register_rejects_dotdot_bare():
    """'..' alone has Path.name == '' so must raise ValueError."""
    with pytest.raises(ValueError, match="invalid file_id"):
        terminals.register_attachment("sec3", "..", name="x.png")


def test_register_accepts_bare_filename():
    """Bare filenames (the happy path) must still work after the guard."""
    tok = terminals.register_attachment("sec4", "ab12cd34.png", name="shot.png", mime="image/png")
    assert tok == "[shot.png]"


def test_attach_route_rejects_path_traversal(client):
    """POST /attach with a traversal file_id must return 400."""
    r = client.post("/api/terminal/secroute/attach",
                    json={"file_id": "../../etc/passwd", "name": "x.png"})
    assert r.status_code == 400


def test_attach_route_rejects_subdir_file_id(client):
    """POST /attach with a subdir file_id must return 400."""
    r = client.post("/api/terminal/secroute/attach",
                    json={"file_id": "a/b.png", "name": "b.png"})
    assert r.status_code == 400
