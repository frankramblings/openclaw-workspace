"""Pure-function tests for the workspace explorer backend (Hermes UI)."""
import os
from pathlib import Path

import pytest

from backend import workspace_files as wf


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "note.md").write_text("hello")
    (tmp_path / "screenshots").mkdir()
    (tmp_path / "screenshots" / "ui.png").write_bytes(b"\x89PNG fake")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref: refs/heads/main")
    (tmp_path / "MEMORY.md").write_text("x" * 2100)
    return tmp_path


def _find(nodes, name):
    return next((n for n in nodes if n["name"] == name), None)


def test_tree_basic_shape_and_sizes(ws):
    tree, truncated = wf.build_tree(ws)
    assert truncated is False
    docs = _find(tree, "docs")
    assert docs["type"] == "dir"
    note = _find(docs["children"], "note.md")
    assert note == {"name": "note.md", "path": "docs/note.md", "type": "file", "size": 5}
    mem = _find(tree, "MEMORY.md")
    assert mem["size"] == 2100


def test_tree_dirs_sort_before_files(ws):
    tree, _ = wf.build_tree(ws)
    names = [n["name"] for n in tree]
    assert names.index("docs") < names.index("MEMORY.md")


def test_git_dir_listed_but_not_walked(ws):
    tree, _ = wf.build_tree(ws)
    git = _find(tree, ".git")
    assert git["type"] == "dir"
    assert git["children"] == []


def test_entry_cap_sets_truncated(ws):
    for i in range(50):
        (ws / f"f{i:03}.txt").write_text("x")
    tree, truncated = wf.build_tree(ws, max_entries=10)
    assert truncated is True


def test_depth_cap(ws):
    d = ws / "a" / "b" / "c"
    d.mkdir(parents=True)
    (d / "deep.txt").write_text("x")
    tree, truncated = wf.build_tree(ws, max_depth=2)
    a = _find(tree, "a")
    b = _find(a["children"], "b")
    assert b["children"] == []          # cut at depth cap
    assert truncated is True


def test_symlinked_dir_not_walked(ws, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    (outside / "secret.txt").write_text("s")
    os.symlink(outside, ws / "link")
    tree, _ = wf.build_tree(ws)
    link = _find(tree, "link")
    assert link is None or link.get("children") in ([], None)


def test_resolve_safe_accepts_normal(ws):
    assert wf.resolve_safe(ws, "docs/note.md") == (ws / "docs" / "note.md").resolve()


@pytest.mark.parametrize("bad", ["../etc/passwd", "docs/../../etc", "/etc/passwd"])
def test_resolve_safe_rejects_escapes(ws, bad):
    with pytest.raises(ValueError):
        wf.resolve_safe(ws, bad)


def test_resolve_safe_rejects_symlink_out(ws, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside2")
    (outside / "secret.txt").write_text("s")
    os.symlink(outside / "secret.txt", ws / "alias.txt")
    with pytest.raises(ValueError):
        wf.resolve_safe(ws, "alias.txt")


def test_git_branch_none_outside_repo(tmp_path):
    assert wf.git_branch(tmp_path) is None


def test_dot_dirs_listed_but_not_walked(ws):
    """Hidden dirs (.attachments etc.) show as childless entries so they don't
    eat the entry budget — the real workspace root is dominated by them."""
    (ws / ".attachments").mkdir()
    for i in range(5):
        (ws / ".attachments" / f"img{i}.png").write_bytes(b"x")
    tree, _ = wf.build_tree(ws)
    dot = _find(tree, ".attachments")
    assert dot["type"] == "dir"
    assert dot["children"] == []


def test_per_dir_cap_preserves_siblings(ws):
    """One huge dir must not starve its siblings: each dir lists at most
    max_per_dir children, so breadth always survives a depth-first walk."""
    big = ws / "aaa_big"
    big.mkdir()
    for i in range(30):
        (big / f"f{i:03}.txt").write_text("x")
    (ws / "zzz_after").mkdir()
    (ws / "zzz_after" / "kept.md").write_text("y")
    tree, truncated = wf.build_tree(ws, max_per_dir=10)
    assert truncated is True
    big_node = _find(tree, "aaa_big")
    assert len(big_node["children"]) == 10
    after = _find(tree, "zzz_after")
    assert after is not None
    assert _find(after["children"], "kept.md") is not None


# --- hidden walking + dirty flag + per-variant cache (Hermes controls) ---
from fastapi.testclient import TestClient

from backend import vault_store as vs
from backend.app import app

client = TestClient(app)


@pytest.fixture()
def api_ws(ws, monkeypatch):
    """ws fixture + WORKSPACE redirected + a clean endpoint cache."""
    monkeypatch.setattr(vs, "WORKSPACE", ws)
    wf._cache.clear()
    return ws


def test_hidden_dirs_walked_with_flag(ws):
    (ws / ".attachments").mkdir()
    (ws / ".attachments" / "img.png").write_bytes(b"x")
    tree, _ = wf.build_tree(ws, include_hidden=True)
    dot = _find(tree, ".attachments")
    assert _find(dot["children"], "img.png") is not None


def test_skip_contents_never_walked_even_hidden(ws):
    tree, _ = wf.build_tree(ws, include_hidden=True)
    assert _find(tree, ".git")["children"] == []


def test_git_dirty_false_outside_repo(tmp_path):
    assert wf.git_dirty(tmp_path) is False


def test_tree_endpoint_hidden_variants_cached_separately(api_ws):
    (api_ws / ".attachments").mkdir()
    (api_ws / ".attachments" / "img.png").write_bytes(b"x")
    r0 = client.get("/api/workspace/tree").json()
    assert "dirty" in r0
    dot0 = next(n for n in r0["tree"] if n["name"] == ".attachments")
    assert dot0["children"] == []
    r1 = client.get("/api/workspace/tree?hidden=1").json()
    dot1 = next(n for n in r1["tree"] if n["name"] == ".attachments")
    assert dot1["children"] != []
    # hidden=0 again must come from its own cache slot, still unwalked
    r2 = client.get("/api/workspace/tree").json()
    dot2 = next(n for n in r2["tree"] if n["name"] == ".attachments")
    assert dot2["children"] == []


# --- mutation guard ---

@pytest.mark.parametrize("bad", [
    ".git/config", "node_modules/x", ".versions/v1",
    "docs/../.git/config", "docs/node_modules/pkg/index.js",
])
def test_resolve_mutable_rejects_protected(ws, bad):
    (ws / "docs" / "node_modules" / "pkg").mkdir(parents=True)
    with pytest.raises(ValueError):
        wf.resolve_mutable(ws, bad)


@pytest.mark.parametrize("bad", [".", "", "../outside"])
def test_resolve_mutable_rejects_root_and_escapes(ws, bad):
    with pytest.raises(ValueError):
        wf.resolve_mutable(ws, bad)


def test_resolve_mutable_accepts_normal_and_new(ws):
    assert wf.resolve_mutable(ws, "docs/note.md") == (ws / "docs" / "note.md").resolve()
    # not-yet-existing targets resolve too (create/mkdir/upload need this)
    assert wf.resolve_mutable(ws, "docs/new-file.md").name == "new-file.md"
