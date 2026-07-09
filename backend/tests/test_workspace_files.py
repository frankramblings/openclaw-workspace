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
from fastapi.testclient import TestClient  # noqa: E402 - intentionally scoped to this section (house style)

from backend import vault_store as vs  # noqa: E402 - intentionally scoped to this section (house style)
from backend.app import app  # noqa: E402 - intentionally scoped to this section (house style)

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


# --- create / mkdir ---

def test_create_file_and_409(api_ws):
    r = client.post("/api/workspace/create", json={"path": "docs/new.md"})
    assert r.status_code == 200
    assert (api_ws / "docs" / "new.md").is_file()
    assert client.post("/api/workspace/create",
                       json={"path": "docs/new.md"}).status_code == 409


def test_create_refuses_protected_and_traversal(api_ws):
    assert client.post("/api/workspace/create",
                       json={"path": ".git/x"}).status_code == 400
    assert client.post("/api/workspace/create",
                       json={"path": "../evil"}).status_code == 400


def test_mkdir_nested_and_409(api_ws):
    assert client.post("/api/workspace/mkdir",
                       json={"path": "newdir/sub"}).status_code == 200
    assert (api_ws / "newdir" / "sub").is_dir()
    assert client.post("/api/workspace/mkdir",
                       json={"path": "newdir/sub"}).status_code == 409


def test_mutation_invalidates_tree_cache(api_ws):
    r0 = client.get("/api/workspace/tree").json()
    assert not any(n["name"] == "made.md" for n in r0["tree"])
    client.post("/api/workspace/create", json={"path": "made.md"})
    r1 = client.get("/api/workspace/tree").json()
    assert any(n["name"] == "made.md" for n in r1["tree"])


# --- rename / move ---

def test_rename_file(api_ws):
    r = client.post("/api/workspace/rename",
                    json={"path": "docs/note.md", "new_name": "renamed.md"})
    assert r.status_code == 200
    assert r.json()["path"] == "docs/renamed.md"
    assert (api_ws / "docs" / "renamed.md").exists()
    assert not (api_ws / "docs" / "note.md").exists()


@pytest.mark.parametrize("bad", ["a/b", "..", ".git", ""])
def test_rename_rejects_bad_names(api_ws, bad):
    r = client.post("/api/workspace/rename",
                    json={"path": "docs/note.md", "new_name": bad})
    assert r.status_code == 400


def test_rename_conflict_409_and_missing_404(api_ws):
    (api_ws / "docs" / "other.md").write_text("y")
    assert client.post("/api/workspace/rename",
                       json={"path": "docs/note.md",
                             "new_name": "other.md"}).status_code == 409
    assert client.post("/api/workspace/rename",
                       json={"path": "docs/nope.md",
                             "new_name": "x.md"}).status_code == 404


def test_move_file_and_to_root(api_ws):
    r = client.post("/api/workspace/move",
                    json={"path": "docs/note.md", "dest_dir": "screenshots"})
    assert r.status_code == 200
    assert (api_ws / "screenshots" / "note.md").exists()
    r2 = client.post("/api/workspace/move",
                     json={"path": "screenshots/note.md", "dest_dir": ""})
    assert r2.status_code == 200
    assert (api_ws / "note.md").exists()


def test_move_dir_into_itself_rejected(api_ws):
    (api_ws / "docs" / "sub").mkdir()
    r = client.post("/api/workspace/move",
                    json={"path": "docs", "dest_dir": "docs/sub"})
    assert r.status_code == 400


def test_move_conflict_and_bad_dest(api_ws):
    (api_ws / "screenshots" / "note.md").write_text("z")
    assert client.post("/api/workspace/move",
                       json={"path": "docs/note.md",
                             "dest_dir": "screenshots"}).status_code == 409
    assert client.post("/api/workspace/move",
                       json={"path": "docs/note.md",
                             "dest_dir": "docs/note.md"}).status_code == 404


# --- delete ---

def test_delete_file_and_dir_recursive(api_ws):
    assert client.post("/api/workspace/delete",
                       json={"path": "docs/note.md"}).status_code == 200
    assert not (api_ws / "docs" / "note.md").exists()
    assert client.post("/api/workspace/delete",
                       json={"path": "screenshots"}).status_code == 200
    assert not (api_ws / "screenshots").exists()


def test_delete_refuses_root_protected_missing(api_ws):
    assert client.post("/api/workspace/delete",
                       json={"path": "."}).status_code == 400
    assert client.post("/api/workspace/delete",
                       json={"path": ".git"}).status_code == 400
    assert client.post("/api/workspace/delete",
                       json={"path": "nope.md"}).status_code == 404


# --- upload ---

def test_upload_and_collision_suffix(api_ws):
    r = client.post("/api/workspace/upload", data={"dir": ""},
                    files=[("files", ("a.txt", b"hello"))])
    assert r.status_code == 200 and r.json()["saved"] == ["a.txt"]
    r2 = client.post("/api/workspace/upload", data={"dir": ""},
                     files=[("files", ("a.txt", b"world"))])
    assert r2.json()["saved"] == ["a (1).txt"]
    assert (api_ws / "a (1).txt").read_bytes() == b"world"


def test_upload_to_subdir_creates_dirs(api_ws):
    r = client.post("/api/workspace/upload", data={"dir": "docs/drops"},
                    files=[("files", ("b.txt", b"x"))])
    assert r.status_code == 200
    assert (api_ws / "docs" / "drops" / "b.txt").exists()


def test_upload_strips_client_paths(api_ws):
    client.post("/api/workspace/upload", data={"dir": "docs"},
                files=[("files", ("../evil.txt", b"x"))])
    assert (api_ws / "docs" / "evil.txt").exists()
    assert not (api_ws / "evil.txt").exists()


def test_upload_cap_and_protected_dir(api_ws, monkeypatch):
    monkeypatch.setattr(wf, "UPLOAD_CAP", 10)
    r = client.post("/api/workspace/upload", data={"dir": ""},
                    files=[("files", ("big.bin", b"x" * 11))])
    assert r.status_code == 413
    assert client.post("/api/workspace/upload", data={"dir": ".git"},
                       files=[("files", ("c.txt", b"x"))]).status_code == 400


# --- archive ---
import io as _io  # noqa: E402 - intentionally scoped to this section (house style)
import zipfile as _zipfile  # noqa: E402 - intentionally scoped to this section (house style)


def test_archive_zips_dir_skipping_protected(api_ws):
    (api_ws / "docs" / "node_modules").mkdir()
    (api_ws / "docs" / "node_modules" / "junk.js").write_text("x")
    r = client.get("/api/workspace/archive?path=docs")
    assert r.status_code == 200
    names = _zipfile.ZipFile(_io.BytesIO(r.content)).namelist()
    assert "docs/note.md" in names
    assert not any("node_modules" in n for n in names)


def test_archive_cap_413(api_ws, monkeypatch):
    monkeypatch.setattr(wf, "ARCHIVE_CAP", 4)
    assert client.get("/api/workspace/archive?path=docs").status_code == 413


def test_archive_rejects_files_and_escapes(api_ws):
    assert client.get("/api/workspace/archive?path=docs/note.md").status_code == 404
    assert client.get("/api/workspace/archive?path=../x").status_code == 400
