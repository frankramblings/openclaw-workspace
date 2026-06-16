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
