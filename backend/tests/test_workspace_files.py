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
