# Explorer Pane Controls (Hermes Parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the read-only WORKSPACE explorer pane to Hermes parity: upload, new file/folder, rename, move, delete, folder zip, hidden-files toggle, git dirty badge, Files/Artifacts tabs, and a resizable panel.

**Architecture:** Backend grows write endpoints in the existing `backend/workspace_files.py` module (FastAPI router, every path through symlink-aware guards plus a new `SKIP_CONTENTS` mutation rail). Frontend stays a self-contained IIFE overlay (`frontend-overrides/js/workspace-explorer.js`, rewritten), with one-line event dispatches added to `chat.js`/`sessions.js` for the Artifacts tab. Helpers lifted from hermes-webui (MIT) are marked as such.

**Tech Stack:** FastAPI + pytest (backend, TDD), vanilla JS IIFE + CSS (frontend, no test harness — verified by `node --check` + curl + user eyeballs; NO headless Chrome on this machine).

**Spec:** `docs/superpowers/specs/2026-06-11-explorer-controls-design.md`

**Repo:** `/Users/admin/openclaw-workspace` (all paths below relative to it). Run pytest from the repo root.

**Deploy reality:** the live backend on :8800 predates even the v1 explorer endpoints and is only restarted by the user (LaunchAgent, pinned env, 2014 Mac mini — never restart it yourself). All backend work here goes live at that one pending restart. The frontend tolerates 404s (pane stays hidden), so syncing frontend early is safe.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `backend/workspace_files.py` | modify | tree `hidden=1` + `dirty`; mutation guard; create/mkdir/rename/move/delete/upload/archive routes |
| `backend/tests/test_workspace_files.py` | modify | TDD tests for all of the above |
| `frontend-overrides/index.html` | modify | explorer header buttons, tabs, upload input, resize handle |
| `frontend-overrides/hermes.css` | modify | styles for buttons, tabs, menu, dialogs, toast, drag highlight, resize |
| `frontend-overrides/js/chat.js` | modify | dispatch `workspace:toolframe` on tool SSE frames (2 lines) |
| `frontend-overrides/js/sessions.js` | modify | dispatch `workspace:session-switch` in `selectSession` (1 line) |
| `frontend-overrides/js/workspace-explorer.js` | rewrite | all pane behavior |
| `frontend/` (via `scripts/sync-frontend.sh`) | generated | sync stamps `sw.js` CACHE_NAME automatically — never edit by hand |

---

### Task 1: Backend — tree `hidden=1`, `dirty` flag, per-variant cache

**Files:**
- Modify: `backend/workspace_files.py` (lines 33, 54-99, 113-127)
- Test: `backend/tests/test_workspace_files.py`

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_workspace_files.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_workspace_files.py -v -k "hidden or dirty"`
Expected: FAIL — `build_tree() got an unexpected keyword argument 'include_hidden'` / `module 'backend.workspace_files' has no attribute 'git_dirty'`

- [ ] **Step 3: Implement**

In `backend/workspace_files.py`:

Replace the cache line (line 33):

```python
_cache: dict = {}  # hidden_flag(bool) -> (timestamp, data); cleared on any mutation
```

Add after `git_branch` (line 51):

```python
def git_dirty(root: Path) -> bool:
    """True when the workspace repo has uncommitted changes; False on any failure."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain"],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return False
    return out.returncode == 0 and bool(out.stdout.strip())
```

In `build_tree`, add the keyword and use it in the walk rule:

```python
def build_tree(root: Path, max_depth: int = MAX_DEPTH,
               max_entries: int = MAX_ENTRIES,
               max_per_dir: int = MAX_PER_DIR,
               include_hidden: bool = False) -> tuple[list[dict], bool]:
```

and change the hidden-dir condition inside `walk` (line 83) to:

```python
                if not is_link and p.name not in SKIP_CONTENTS \
                        and (include_hidden or not p.name.startswith(".")):
```

Replace `workspace_tree` (lines 113-127):

```python
@router.get("/api/workspace/tree")
def workspace_tree(fresh: int = 0, hidden: int = 0):
    key = bool(hidden)
    now = time.time()
    ent = _cache.get(key)
    if not fresh and ent is not None and now - ent[0] < CACHE_TTL:
        return ent[1]
    root = workspace_root()
    if not root.is_dir():
        data = {"root": str(root), "branch": None, "dirty": False, "tree": [],
                "truncated": False, "missing": True}
    else:
        tree, truncated = build_tree(root, include_hidden=key)
        data = {"root": str(root), "branch": git_branch(root),
                "dirty": git_dirty(root), "tree": tree,
                "truncated": truncated, "missing": False}
    _cache[key] = (now, data)
    return data
```

- [ ] **Step 4: Run the full test file**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_workspace_files.py -v`
Expected: ALL PASS (old tests untouched by the signature change — `include_hidden` defaults to False)

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/workspace_files.py backend/tests/test_workspace_files.py
git commit -m "feat(explorer-api): tree hidden=1 walking, git dirty flag, per-variant cache"
```

---

### Task 2: Backend — mutation guard `resolve_mutable`

**Files:**
- Modify: `backend/workspace_files.py`
- Test: `backend/tests/test_workspace_files.py`

- [ ] **Step 1: Write the failing tests** — append:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_workspace_files.py -v -k resolve_mutable`
Expected: FAIL — `has no attribute 'resolve_mutable'`

- [ ] **Step 3: Implement** — add after `resolve_safe` (line 110), and update the module docstring's "Read-only by construction" sentence to: `Read routes are GET; mutation routes are POST and additionally refuse SKIP_CONTENTS segments and the workspace root itself.`

```python
def resolve_mutable(root: Path, rel: str) -> Path:
    """`resolve_safe` plus mutation rails: never the workspace root itself and
    never inside a protected segment (.git, .versions, node_modules, ...) — the
    explorer must not be able to nuke vault history or repo internals, even
    past a confirm dialog. The target itself may not exist yet (create paths).
    """
    target = resolve_safe(root, rel)
    rootr = root.resolve()
    if target == rootr:
        raise ValueError("workspace root is not mutable")
    for seg in target.relative_to(rootr).parts:
        if seg in SKIP_CONTENTS:
            raise ValueError("protected path")
    return target
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_workspace_files.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/workspace_files.py backend/tests/test_workspace_files.py
git commit -m "feat(explorer-api): resolve_mutable guard (root + SKIP_CONTENTS rails)"
```

---

### Task 3: Backend — create + mkdir endpoints

**Files:**
- Modify: `backend/workspace_files.py`
- Test: `backend/tests/test_workspace_files.py`

- [ ] **Step 1: Write the failing tests** — append:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_workspace_files.py -v -k "create or mkdir or invalidates"`
Expected: FAIL with 404s (routes missing)

- [ ] **Step 3: Implement** — add imports at the top of `workspace_files.py` (`shutil` in the stdlib block; `pydantic` after the fastapi imports):

```python
import shutil
```
```python
from pydantic import BaseModel
```

Add after `resolve_mutable`:

```python
class PathBody(BaseModel):
    path: str


def _invalidate_cache() -> None:
    _cache.clear()


def _mutable_or_400(rel: str) -> Path:
    try:
        return resolve_mutable(workspace_root(), rel)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/workspace/create")
def workspace_create(body: PathBody):
    target = _mutable_or_400(body.path)
    if target.exists():
        raise HTTPException(status_code=409, detail="already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.touch()
    _invalidate_cache()
    return {"ok": True, "path": body.path}


@router.post("/api/workspace/mkdir")
def workspace_mkdir(body: PathBody):
    target = _mutable_or_400(body.path)
    if target.exists():
        raise HTTPException(status_code=409, detail="already exists")
    target.mkdir(parents=True, exist_ok=True)
    _invalidate_cache()
    return {"ok": True, "path": body.path}
```

- [ ] **Step 4: Run tests** — `python -m pytest backend/tests/test_workspace_files.py -v` → ALL PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/workspace_files.py backend/tests/test_workspace_files.py
git commit -m "feat(explorer-api): create + mkdir endpoints"
```

---

### Task 4: Backend — rename + move endpoints

**Files:**
- Modify: `backend/workspace_files.py`
- Test: `backend/tests/test_workspace_files.py`

- [ ] **Step 1: Write the failing tests** — append:

```python
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
```

- [ ] **Step 2: Run to verify failure** — `python -m pytest backend/tests/test_workspace_files.py -v -k "rename or move"` → FAIL with 404s

- [ ] **Step 3: Implement** — add after `workspace_mkdir`:

```python
class RenameBody(BaseModel):
    path: str
    new_name: str


class MoveBody(BaseModel):
    path: str
    dest_dir: str = ""


@router.post("/api/workspace/rename")
def workspace_rename(body: RenameBody):
    rootr = workspace_root().resolve()
    src = _mutable_or_400(body.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="not found")
    name = body.new_name.strip()
    if (not name or "/" in name or "\\" in name or "\x00" in name
            or name in (".", "..") or name in SKIP_CONTENTS):
        raise HTTPException(status_code=400, detail="invalid name")
    dst = src.with_name(name)
    if dst.exists():
        raise HTTPException(status_code=409, detail="target exists")
    src.rename(dst)
    _invalidate_cache()
    return {"ok": True, "path": dst.relative_to(rootr).as_posix()}


@router.post("/api/workspace/move")
def workspace_move(body: MoveBody):
    rootr = workspace_root().resolve()
    src = _mutable_or_400(body.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="not found")
    dd = body.dest_dir.strip().strip("/")
    dest = rootr if dd in ("", ".") else _mutable_or_400(dd)
    if not dest.is_dir():
        raise HTTPException(status_code=404, detail="destination is not a directory")
    if dest == src or src in dest.parents:
        raise HTTPException(status_code=400, detail="cannot move a folder into itself")
    dst = dest / src.name
    if dst.exists():
        raise HTTPException(status_code=409, detail="target exists")
    shutil.move(str(src), str(dst))
    _invalidate_cache()
    return {"ok": True, "path": dst.relative_to(rootr).as_posix()}
```

- [ ] **Step 4: Run tests** — `python -m pytest backend/tests/test_workspace_files.py -v` → ALL PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/workspace_files.py backend/tests/test_workspace_files.py
git commit -m "feat(explorer-api): rename + move endpoints"
```

---

### Task 5: Backend — delete endpoint

**Files:**
- Modify: `backend/workspace_files.py`
- Test: `backend/tests/test_workspace_files.py`

- [ ] **Step 1: Write the failing tests** — append:

```python
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
```

- [ ] **Step 2: Run to verify failure** — `python -m pytest backend/tests/test_workspace_files.py -v -k delete` → FAIL with 404s

- [ ] **Step 3: Implement** — add after `workspace_move`:

```python
@router.post("/api/workspace/delete")
def workspace_delete(body: PathBody):
    target = _mutable_or_400(body.path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    _invalidate_cache()
    return {"ok": True}
```

- [ ] **Step 4: Run tests** — `python -m pytest backend/tests/test_workspace_files.py -v` → ALL PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/workspace_files.py backend/tests/test_workspace_files.py
git commit -m "feat(explorer-api): delete endpoint (recursive for dirs)"
```

---

### Task 6: Backend — upload endpoint (multipart, collision suffix, 50MB cap)

**Files:**
- Modify: `backend/workspace_files.py`
- Test: `backend/tests/test_workspace_files.py`

Note: `python-multipart` is already a dependency (chat-attachment uploads use it).

- [ ] **Step 1: Write the failing tests** — append:

```python
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
```

- [ ] **Step 2: Run to verify failure** — `python -m pytest backend/tests/test_workspace_files.py -v -k upload` → FAIL with 404s

- [ ] **Step 3: Implement** — extend the fastapi import line to:

```python
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
```

Add constant next to `PREVIEW_CAP` (line 25):

```python
UPLOAD_CAP = 50 * 1024 * 1024   # bytes per uploaded file
```

Add after `workspace_delete`:

```python
def _dedupe_name(p: Path) -> Path:
    """Finder-style collision suffix: a.txt -> a (1).txt -> a (2).txt ..."""
    if not p.exists():
        return p
    for i in range(1, 1000):
        cand = p.with_name(f"{p.stem} ({i}){p.suffix}")
        if not cand.exists():
            return cand
    raise HTTPException(status_code=409, detail="too many name collisions")


@router.post("/api/workspace/upload")
async def workspace_upload(files: list[UploadFile] = File(...),
                           dest: str = Form("", alias="dir")):
    rootr = workspace_root().resolve()
    dd = dest.strip().strip("/")
    target_dir = rootr if dd in ("", ".") else _mutable_or_400(dd)
    if target_dir.exists() and not target_dir.is_dir():
        raise HTTPException(status_code=400, detail="destination is not a directory")
    target_dir.mkdir(parents=True, exist_ok=True)  # folder drops create paths
    saved = []
    for f in files:
        data = await f.read()
        if len(data) > UPLOAD_CAP:
            raise HTTPException(status_code=413,
                                detail=f"{f.filename} exceeds 50MB upload cap")
        name = Path(f.filename or "upload").name  # strip any client-sent path
        target = _dedupe_name(target_dir / name)
        target.write_bytes(data)
        saved.append(target.relative_to(rootr).as_posix())
    _invalidate_cache()
    return {"ok": True, "saved": saved}
```

- [ ] **Step 4: Run tests** — `python -m pytest backend/tests/test_workspace_files.py -v` → ALL PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/workspace_files.py backend/tests/test_workspace_files.py
git commit -m "feat(explorer-api): multipart upload with collision suffix and 50MB cap"
```

---

### Task 7: Backend — folder zip archive endpoint

**Files:**
- Modify: `backend/workspace_files.py`
- Test: `backend/tests/test_workspace_files.py`

- [ ] **Step 1: Write the failing tests** — append:

```python
# --- archive ---
import io as _io
import zipfile as _zipfile


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
```

- [ ] **Step 2: Run to verify failure** — `python -m pytest backend/tests/test_workspace_files.py -v -k archive` → FAIL with 404s

- [ ] **Step 3: Implement** — add `io`, `os`, `zipfile` to the stdlib import block; add `Response` to the responses import:

```python
import io
import os
import zipfile
```
```python
from fastapi.responses import FileResponse, PlainTextResponse, Response
```

Add constant next to `UPLOAD_CAP`:

```python
ARCHIVE_CAP = 100 * 1024 * 1024  # uncompressed bytes per folder zip
```

Add after `workspace_upload`:

```python
@router.get("/api/workspace/archive")
def workspace_archive(path: str):
    """Zip a workspace folder for download. Prunes SKIP_CONTENTS, refuses
    oversize folders (the 2014 mini builds the zip in RAM)."""
    root = workspace_root()
    try:
        target = resolve_safe(root, path)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="not a directory")
    total = 0
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(target):
            dirnames[:] = [d for d in dirnames
                           if d not in SKIP_CONTENTS
                           and not Path(dirpath, d).is_symlink()]
            for fn in sorted(filenames):
                p = Path(dirpath) / fn
                if p.is_symlink() or not p.is_file():
                    continue
                total += p.stat().st_size
                if total > ARCHIVE_CAP:
                    raise HTTPException(status_code=413,
                                        detail="folder too large to zip")
                zf.write(p, p.relative_to(target.parent).as_posix())
    return Response(
        buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition":
                 f'attachment; filename="{target.name}.zip"'})
```

- [ ] **Step 4: Run tests** — `python -m pytest backend/tests/test_workspace_files.py -v` → ALL PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/workspace_files.py backend/tests/test_workspace_files.py
git commit -m "feat(explorer-api): folder zip archive endpoint"
```

---

### Task 8: Frontend markup — explorer header buttons, tabs, upload input, resize handle

**Files:**
- Modify: `frontend-overrides/index.html:1220-1230`

- [ ] **Step 1: Replace the explorer aside block.** Current block (lines 1220-1230):

```html
  <!-- HERMES: right-hand WORKSPACE explorer (read-only; Phase 3) -->
  <aside id="workspace-explorer" hidden aria-label="Workspace files">
    <div class="we-header">
      <span class="we-title">WORKSPACE</span>
      <span id="we-branch" class="we-branch" hidden></span>
      <button type="button" id="we-refresh" title="Refresh">&#x27F3;</button>
      <button type="button" id="we-collapse" title="Hide panel">&#x2715;</button>
    </div>
    <div id="we-tree" class="we-tree"></div>
  </aside>
  <button type="button" id="we-reopen" title="Workspace files" hidden>Files</button>
```

Replace with:

```html
  <!-- HERMES: right-hand WORKSPACE explorer (Phase 3 + Hermes-parity controls) -->
  <aside id="workspace-explorer" hidden aria-label="Workspace files">
    <div id="we-resize" aria-hidden="true"></div>
    <div class="we-header">
      <span class="we-title">WORKSPACE</span>
      <span id="we-hidden-ind" title="Hidden files are visible — toggle in options" hidden>&#x25CE;</span>
      <span id="we-branch" class="we-branch" hidden></span>
      <button type="button" id="we-new-file" title="New file">&#xFF0B;</button>
      <button type="button" id="we-new-folder" title="New folder">&#x229E;</button>
      <button type="button" id="we-upload" title="Upload files">&#x2912;</button>
      <button type="button" id="we-prefs" title="Options">&#x22EF;</button>
      <button type="button" id="we-refresh" title="Refresh">&#x27F3;</button>
      <button type="button" id="we-collapse" title="Hide panel">&#x2715;</button>
    </div>
    <div class="we-tabs" role="tablist" aria-label="Explorer views">
      <button type="button" id="we-tab-files" class="we-tab active" role="tab">Files</button>
      <button type="button" id="we-tab-artifacts" class="we-tab" role="tab">Artifacts <span id="we-art-count">0</span></button>
    </div>
    <input type="file" id="we-upload-input" multiple hidden>
    <div id="we-tree" class="we-tree"></div>
    <div id="we-artifacts" class="we-artifacts" hidden></div>
  </aside>
  <button type="button" id="we-reopen" title="Workspace files" hidden>Files</button>
```

- [ ] **Step 2: Sanity check** — `grep -c 'we-tab-artifacts\|we-upload-input\|we-resize' frontend-overrides/index.html` → Expected: `3`

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/index.html
git commit -m "feat(explorer): header controls, tabs, upload input, resize handle markup"
```

---

### Task 9: Frontend CSS — controls, tabs, menu, dialogs, toast, drag, resize

**Files:**
- Modify: `frontend-overrides/hermes.css` (append after the existing explorer block, which ends near line 333)

- [ ] **Step 1: Append this block** to `frontend-overrides/hermes.css`:

```css
/* ---- Explorer Hermes-parity controls (2026-06-11) ---- */
#workspace-explorer { position: relative; }
#we-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 5; touch-action: none; }
.we-header #we-refresh { margin-left: 0; }        /* old auto-push superseded */
.we-header #we-new-file { margin-left: auto; }    /* button cluster sits right */
#we-hidden-ind { color: var(--red); font-size: 10px; }
.we-tabs { display: flex; gap: 2px; padding: 0 6px; border-bottom: 1px solid color-mix(in srgb, var(--fg) 15%, transparent); }
.we-tab { background: none; border: none; color: var(--hermes-faint); font: inherit; font-size: 11px; padding: 4px 8px; cursor: pointer; border-bottom: 2px solid transparent; }
.we-tab.active { color: var(--fg); border-bottom-color: var(--red); }
#we-art-count { opacity: .6; }
.we-artifacts { overflow-y: auto; flex: 1; padding: 6px 4px; font-size: 12px; }
.we-artifact { padding: 3px 8px; cursor: pointer; border-radius: 4px; }
.we-artifact:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); }
.we-artifact .we-art-dir { color: var(--hermes-faint); font-size: 10px; display: block; }
.we-menu { position: fixed; z-index: 1000; min-width: 160px; background: var(--bg); border: 1px solid color-mix(in srgb, var(--fg) 25%, transparent); border-radius: 6px; padding: 4px 0; font-size: 13px; box-shadow: 0 6px 24px rgba(0, 0, 0, .35); }
.we-menu-item { padding: 6px 14px; cursor: pointer; }
.we-menu-item:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.we-menu-item.danger { color: var(--accent-error, #e94560); }
.we-menu hr { border: none; border-top: 1px solid color-mix(in srgb, var(--fg) 15%, transparent); margin: 4px 0; }
.we-dialog-overlay { position: fixed; inset: 0; z-index: 1001; background: rgba(0, 0, 0, .45); display: flex; align-items: center; justify-content: center; }
.we-dialog { background: var(--bg); color: var(--fg); border: 1px solid color-mix(in srgb, var(--fg) 25%, transparent); border-radius: 8px; padding: 16px; min-width: 280px; max-width: 90vw; font-size: 13px; }
.we-dialog input { width: 100%; margin-top: 10px; font: inherit; padding: 6px 8px; background: transparent; color: var(--fg); border: 1px solid color-mix(in srgb, var(--fg) 25%, transparent); border-radius: 4px; box-sizing: border-box; }
.we-dialog-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.we-dialog-btns button { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--fg) 25%, transparent); background: none; color: var(--fg); cursor: pointer; }
.we-dialog-btns button.danger { color: #fff; background: var(--accent-error, #e94560); border-color: transparent; }
.we-toast { position: fixed; bottom: 18px; right: 18px; z-index: 1002; background: var(--bg); color: var(--fg); border: 1px solid color-mix(in srgb, var(--fg) 25%, transparent); border-radius: 6px; padding: 8px 14px; font-size: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, .3); }
.we-file.drag-over, .we-tree summary.drag-over { background: color-mix(in srgb, var(--red) 18%, transparent); }
.we-file.dragging { opacity: .5; }
```

- [ ] **Step 2: Sanity check** — `grep -c 'we-toast' frontend-overrides/hermes.css` → Expected: `1`

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/hermes.css
git commit -m "feat(explorer): CSS for controls, tabs, context menu, dialogs, drag, resize"
```

---

### Task 10: Frontend — tool-frame + session-switch event dispatches

**Files:**
- Modify: `frontend-overrides/js/chat.js:1934` and `frontend-overrides/js/chat.js:2074`
- Modify: `frontend-overrides/js/sessions.js:1556`

- [ ] **Step 1: chat.js `tool_start`** (line ~1934). Change:

```js
              } else if (json.type === 'tool_start') {
                if (_isBg) continue;
```

to:

```js
              } else if (json.type === 'tool_start') {
                try { window.dispatchEvent(new CustomEvent('workspace:toolframe', { detail: json })); } catch (_we) {}
                if (_isBg) continue;
```

- [ ] **Step 2: chat.js `tool_output`** (line ~2074). Change:

```js
              } else if (json.type === 'tool_output') {
                if (_isBg) continue;
```

to:

```js
              } else if (json.type === 'tool_output') {
                try { window.dispatchEvent(new CustomEvent('workspace:toolframe', { detail: json })); } catch (_we) {}
                if (_isBg) continue;
```

(Dispatch goes BEFORE the `_isBg` skip on purpose — background-session frames still carry artifact paths.)

- [ ] **Step 3: sessions.js `selectSession`** (line ~1556). Insert as the FIRST statement of the function body:

```js
export async function selectSession(id, { keepSidebar = false } = {}) {
  try { window.dispatchEvent(new CustomEvent('workspace:session-switch')); } catch (_we) {}
```

- [ ] **Step 4: Syntax check** (ESM files — plain `node --check` would choke on `export`):

```bash
cd /Users/admin/openclaw-workspace
node --input-type=module --check < frontend-overrides/js/chat.js
node --input-type=module --check < frontend-overrides/js/sessions.js
```

Expected: no output (exit 0)

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/chat.js frontend-overrides/js/sessions.js
git commit -m "feat(explorer): dispatch workspace:toolframe + session-switch events"
```

---

### Task 11: Frontend — rewrite `workspace-explorer.js` with all controls

**Files:**
- Rewrite: `frontend-overrides/js/workspace-explorer.js`

The file stays a self-contained IIFE (no module imports — it is injected as a plain `<script defer>`). `fmt`, `esc`, `openInEditor`, `openFile`, `preview`, `applyCollapsed` carry over from v1 unchanged. Blocks marked "lifted from hermes-webui" are MIT-licensed code from the pinned reference clone.

- [ ] **Step 1: Replace the entire file** with:

```js
// HERMES: WORKSPACE explorer pane — workspace tree with Hermes-parity
// controls: upload (button + OS drag-drop), new file/folder, rename / move /
// delete via context menu (right-click; ~500ms long-press on touch), hidden
// files toggle, git dirty badge, Files/Artifacts tabs, resizable panel.
// Self-contained overlay (no module imports), tolerant of a backend that
// doesn't have /api/workspace yet (pane stays hidden; ops toast HTTP errors).
// Blocks marked "lifted from hermes-webui" are MIT (nesquena/hermes-webui).
(function () {
  const LS_COLLAPSED = 'hermes-explorer-collapsed';
  const LS_EXPANDED = 'hermes-explorer-expanded';
  const LS_HIDDEN = 'hermes-workspace-show-hidden';
  const LS_WIDTH = 'hermes-explorer-width';

  const state = {
    showHidden: localStorage.getItem(LS_HIDDEN) === '1',
    expanded: null,          // Set<dirPath> | null = no saved state (depth<1 open)
    root: '',                // absolute workspace root from the tree response
    knownFiles: new Set(),   // rel paths of files in the loaded tree
    knownDirs: new Set(),
    artifacts: [],           // [{path}] newest first; session-scoped
    pending: new Set(),      // harvested tokens not (yet) matching the tree
    tab: 'files',
  };
  let _available = false;
  let _suppressClick = false; // swallow the synthetic click after a long-press
  let _refreshTimer = null;

  try {
    const saved = JSON.parse(localStorage.getItem(LS_EXPANDED) || 'null');
    if (Array.isArray(saved)) state.expanded = new Set(saved);
  } catch (_e) { /* corrupted state — fall back to default-open */ }

  const fmt = (n) => {
    if (n == null) return '';
    if (n < 1024) return n + 'b';
    const k = n / 1024;
    return (k >= 100 ? Math.round(k) : k.toFixed(1)) + 'k';
  };
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const baseName = (p) => p.split('/').pop();
  const parentDir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const joinPath = (base, rel) => {
    const r = (rel || '').replace(/^\/+|\/+$/g, '');
    if (!r) return base || '';
    return base ? base + '/' + r : r;
  };

  // ---------- toast + dialogs ----------
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'we-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  function dialog(opts) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'we-dialog-overlay';
      ov.innerHTML = '<div class="we-dialog"><div class="we-dialog-msg"></div>' +
        (opts.input ? '<input type="text">' : '') +
        '<div class="we-dialog-btns"><button type="button" class="we-cancel">Cancel</button>' +
        '<button type="button" class="we-ok' + (opts.danger ? ' danger' : '') + '"></button></div></div>';
      ov.querySelector('.we-dialog-msg').textContent = opts.message;
      ov.querySelector('.we-ok').textContent = opts.confirmLabel || 'OK';
      const input = ov.querySelector('input');
      if (input) {
        input.value = opts.value || '';
        if (opts.placeholder) input.placeholder = opts.placeholder;
      }
      const done = (val) => {
        ov.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      };
      const ok = () => done(input ? input.value.trim() : true);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && input) { e.stopPropagation(); ok(); }
      };
      document.addEventListener('keydown', onKey, true);
      ov.querySelector('.we-cancel').addEventListener('click', () => done(null));
      ov.querySelector('.we-ok').addEventListener('click', ok);
      ov.addEventListener('click', (e) => { if (e.target === ov) done(null); });
      document.body.appendChild(ov);
      setTimeout(() => {
        if (!input) { ov.querySelector(opts.danger ? '.we-cancel' : '.we-ok').focus(); return; }
        input.focus();
        // Finder-style stem selection — lifted from hermes-webui (MIT):
        // select the basename before the LAST '.', so retyping keeps the
        // extension; dotfiles ('.gitignore') and no-dot names full-select.
        const v = input.value || '';
        if (opts.selectStem && v) {
          const dot = v.lastIndexOf('.');
          if (dot > 0) input.setSelectionRange(0, dot);
          else input.select();
        } else if (opts.selectAll && v) input.select();
      }, 0);
    });
  }
  const showPrompt = (o) => dialog(Object.assign({}, o, { input: true }));
  const showConfirm = (o) => dialog(Object.assign({}, o, { input: false })).then((v) => v === true);

  // ---------- api ----------
  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let d = '';
      try { d = (await r.json()).detail || ''; } catch (_e) { /* non-JSON error */ }
      throw new Error(d || 'HTTP ' + r.status);
    }
    return r.json();
  }

  // ---------- tree ----------
  function renderNodes(nodes, depth) {
    return nodes.map((n) => {
      if (!state.showHidden && n.name.startsWith('.')) return '';
      if (n.type === 'dir') {
        const kids = n.children && n.children.length
          ? renderNodes(n.children, depth + 1) : '';
        const open = state.expanded ? state.expanded.has(n.path) : depth < 1;
        return `<details class="we-dir" data-path="${esc(n.path)}" ${open ? 'open' : ''}>` +
          `<summary style="--we-depth:${depth}" data-path="${esc(n.path)}" data-type="dir" draggable="true">${esc(n.name)}</summary>${kids}</details>`;
      }
      return `<div class="we-file" style="--we-depth:${depth}" data-path="${esc(n.path)}" data-type="file" draggable="true">` +
        `<span class="we-name">${esc(n.name)}</span>` +
        `<span class="we-size">${fmt(n.size)}</span></div>`;
    }).join('');
  }

  function indexTree(nodes) {
    for (const n of nodes) {
      if (n.type === 'dir') {
        state.knownDirs.add(n.path);
        if (n.children) indexTree(n.children);
      } else state.knownFiles.add(n.path);
    }
  }

  function saveExpanded() {
    if (state.expanded) localStorage.setItem(LS_EXPANDED, JSON.stringify([...state.expanded]));
  }

  async function load(fresh) {
    let data = null;
    try {
      const url = '/api/workspace/tree?hidden=' + (state.showHidden ? '1' : '0') +
        (fresh ? '&fresh=1' : '');
      const r = await fetch(url, { credentials: 'same-origin' });
      if (r.ok) data = await r.json();
    } catch (_e) { /* backend not restarted yet — stay hidden */ }
    const pane = document.getElementById('workspace-explorer');
    if (!pane) return;
    if (!data || !Array.isArray(data.tree)) {
      pane.hidden = true;
      const reopen = document.getElementById('we-reopen');
      if (reopen) reopen.hidden = true;
      return;
    }
    state.root = (data.root || '').replace(/\/+$/, '');
    const branch = document.getElementById('we-branch');
    if (branch) {
      branch.textContent = (data.branch || '') + (data.branch && data.dirty ? ' ●' : '');
      branch.title = data.dirty ? 'Uncommitted changes' : '';
      branch.hidden = !data.branch;
    }
    const ind = document.getElementById('we-hidden-ind');
    if (ind) ind.hidden = !state.showHidden;
    state.knownFiles = new Set();
    state.knownDirs = new Set();
    indexTree(data.tree);
    const tree = document.getElementById('we-tree');
    tree.innerHTML = data.missing
      ? '<div class="we-empty">workspace directory not found</div>'
      : (renderNodes(data.tree, 0) +
         (data.truncated ? '<div class="we-empty">… listing truncated</div>' : ''));
    _available = true;
    matchPending();
    applyCollapsed();
  }

  function applyCollapsed() {
    if (!_available) return;
    const collapsed = localStorage.getItem(LS_COLLAPSED) === '1';
    const pane = document.getElementById('workspace-explorer');
    const reopen = document.getElementById('we-reopen');
    if (pane) pane.hidden = collapsed;
    if (reopen) reopen.hidden = !collapsed;
  }

  // ---------- open / preview (unchanged from v1) ----------
  async function openInEditor(path) {
    let data = null;
    try {
      const r = await fetch('/api/vault/open?path=' + encodeURIComponent(path),
        { credentials: 'same-origin' });
      if (!r.ok) return false;
      data = await r.json();
    } catch (_e) { return false; }
    const dm = window.documentModule;
    if (!dm || !dm.injectFreshDoc || !data || !data.id) return false;
    dm.injectFreshDoc(data);
    return true;
  }

  function openFile(path) {
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(path.toLowerCase())) { preview(path); return; }
    openInEditor(path).then((ok) => { if (!ok) preview(path); });
  }

  function preview(path) {
    const url = '/api/workspace/file?path=' + encodeURIComponent(path);
    const lower = path.toLowerCase();
    const isImg = /\.(png|jpe?g|gif|webp|svg)$/.test(lower);
    const overlay = document.createElement('div');
    overlay.id = 'we-preview-overlay';
    overlay.innerHTML =
      `<div id="we-preview"><div class="we-preview-head">` +
      `<span class="hermes-mono">${esc(path)}</span>` +
      `<a href="${url}" download>Download</a>` +
      `<button type="button" id="we-preview-close">&#x2715;</button></div>` +
      `<div class="we-preview-body">${isImg ? `<img src="${url}" alt="">` : '<pre></pre>'}</div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.id === 'we-preview-close') overlay.remove();
    });
    if (!isImg) {
      fetch(url).then((r) => r.ok ? r.text() : Promise.reject(r.status))
        .then((t) => { overlay.querySelector('pre').textContent = t; })
        .catch(() => { overlay.querySelector('pre').textContent = '(binary file — use Download)'; });
    }
  }

  // ---------- file ops ----------
  async function doCreate(dir, isFolder) {
    const name = await showPrompt({
      message: (isFolder ? 'New folder in ' : 'New file in ') + (dir || 'workspace root'),
      placeholder: isFolder ? 'folder-name' : 'filename.md',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const rel = dir ? dir + '/' + name : name;
    try {
      await post(isFolder ? '/api/workspace/mkdir' : '/api/workspace/create', { path: rel });
      toast('Created ' + name);
      if (dir && state.expanded) { state.expanded.add(dir); saveExpanded(); }
      await load(true);
      if (!isFolder) openFile(rel);
    } catch (e) { toast('Create failed: ' + e.message); }
  }

  async function doRename(item) {
    const name = await showPrompt({
      message: 'Rename ' + item.name, value: item.name, confirmLabel: 'Rename',
      selectStem: item.type !== 'dir', selectAll: item.type === 'dir',
    });
    if (!name || name === item.name) return;
    try {
      await post('/api/workspace/rename', { path: item.path, new_name: name });
      toast('Renamed to ' + name);
      load(true);
    } catch (e) { toast('Rename failed: ' + e.message); }
  }

  async function doMove(item) {
    const dest = await showPrompt({
      message: 'Move ' + item.name + ' to folder (empty = workspace root)',
      value: parentDir(item.path), confirmLabel: 'Move',
    });
    if (dest === null) return;
    try {
      await post('/api/workspace/move', { path: item.path, dest_dir: dest });
      toast('Moved ' + item.name);
      load(true);
    } catch (e) { toast('Move failed: ' + e.message); }
  }

  async function doDelete(item) {
    const ok = await showConfirm({
      message: item.type === 'dir'
        ? 'Delete folder "' + item.name + '" and everything inside it? This cannot be undone.'
        : 'Delete "' + item.name + '"? This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await post('/api/workspace/delete', { path: item.path });
      toast('Deleted ' + item.name);
      load(true);
    } catch (e) { toast('Delete failed: ' + e.message); }
  }

  function copyPath(item) {
    const abs = state.root ? state.root + '/' + item.path : item.path;
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = abs;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_e) { /* denied */ }
      ta.remove();
      toast(ok ? 'Path copied' : 'Copy failed');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(abs).then(() => toast('Path copied'), fallback);
    } else fallback();
  }

  function downloadItem(item) {
    const url = item.type === 'dir'
      ? '/api/workspace/archive?path=' + encodeURIComponent(item.path)
      : '/api/workspace/file?path=' + encodeURIComponent(item.path);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name + (item.type === 'dir' ? '.zip' : '');
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- context menu ----------
  function closeMenu() {
    document.querySelectorAll('.we-menu').forEach((m) => m.remove());
  }

  function itemFromRow(row) {
    const path = row.dataset.path;
    return { path, type: row.dataset.type === 'dir' ? 'dir' : 'file', name: baseName(path) };
  }

  function menuShell() {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'we-menu';
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        closeMenu();
        document.removeEventListener('click', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
    return menu;
  }

  function placeMenu(menu, x, y) {
    document.body.appendChild(menu);
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }

  function showMenu(item, x, y) {
    const menu = menuShell();
    const add = (label, fn, cls) => {
      const it = document.createElement('div');
      it.className = 'we-menu-item' + (cls ? ' ' + cls : '');
      it.textContent = label;
      it.addEventListener('click', () => { closeMenu(); fn(); });
      menu.appendChild(it);
    };
    if (item.type === 'dir') {
      add('New file here', () => doCreate(item.path, false));
      add('New folder here', () => doCreate(item.path, true));
      add('Rename', () => doRename(item));
      add('Move to…', () => doMove(item));
      add('Download zip', () => downloadItem(item));
    } else {
      add('Open', () => openFile(item.path));
      add('Rename', () => doRename(item));
      add('Move to…', () => doMove(item));
      add('Copy path', () => copyPath(item));
      add('Download', () => downloadItem(item));
    }
    menu.appendChild(document.createElement('hr'));
    add('Delete', () => doDelete(item), 'danger');
    placeMenu(menu, x, y);
  }

  function showPrefs(anchor) {
    const menu = menuShell();
    const it = document.createElement('div');
    it.className = 'we-menu-item';
    it.innerHTML = '<label style="display:flex;gap:8px;align-items:center;cursor:pointer">' +
      '<input type="checkbox"' + (state.showHidden ? ' checked' : '') + '> Show hidden files</label>';
    it.querySelector('input').addEventListener('change', (e) => {
      state.showHidden = e.target.checked;
      localStorage.setItem(LS_HIDDEN, state.showHidden ? '1' : '0');
      load(true);
    });
    menu.appendChild(it);
    const r = anchor.getBoundingClientRect();
    placeMenu(menu, r.left, r.bottom + 4);
  }

  function bindLongPress(tree) {
    let timer = null, sx = 0, sy = 0;
    tree.addEventListener('touchstart', (e) => {
      const row = e.target.closest('.we-file, summary[data-type="dir"]');
      if (!row) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      timer = setTimeout(() => {
        timer = null;
        // iOS fires a synthetic click after touchend (and sometimes none at
        // all after long holds) — suppress the next click briefly so the
        // menu isn't instantly dismissed or the file opened.
        _suppressClick = true;
        setTimeout(() => { _suppressClick = false; }, 700);
        showMenu(itemFromRow(row), sx, sy);
      }, 500);
    }, { passive: true });
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    tree.addEventListener('touchmove', (e) => {
      if (!timer) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
    }, { passive: true });
    tree.addEventListener('touchend', cancel, { passive: true });
    tree.addEventListener('touchcancel', cancel, { passive: true });
  }

  // ---------- upload ----------
  async function uploadFiles(files, dir) {
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.append('dir', dir || '');
    try {
      const r = await fetch('/api/workspace/upload',
        { method: 'POST', credentials: 'same-origin', body: fd });
      if (!r.ok) {
        let d = '';
        try { d = (await r.json()).detail || ''; } catch (_e) { /* non-JSON */ }
        throw new Error(d || 'HTTP ' + r.status);
      }
      toast('Uploaded ' + files.length + (files.length > 1 ? ' files' : ' file'));
      load(true);
    } catch (e) { toast('Upload failed: ' + e.message); }
  }

  // ---- OS drag-drop upload helpers — lifted from hermes-webui (MIT) ----
  function isOsFilesDrag(e) {
    return !!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files'));
  }
  function isMoveDrag(e) {
    return !!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('application/ws-path'));
  }
  async function readAllDirectoryEntries(reader) {
    const entries = [];
    while (true) {
      const batch = await new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (!batch.length) break;
      entries.push(...batch);
    }
    return entries;
  }
  async function collectFilesFromEntry(entry, relPrefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => { entry.file(resolve, reject); });
      return [{ file, relDir: relPrefix || '' }];
    }
    if (!entry.isDirectory) return [];
    const reader = entry.createReader();
    const children = await readAllDirectoryEntries(reader);
    const dirPrefix = `${relPrefix || ''}${entry.name}/`;
    let out = [];
    for (const child of children) {
      out = out.concat(await collectFilesFromEntry(child, dirPrefix));
    }
    return out;
  }
  async function collectOsDropUploads(dataTransfer) {
    const out = [];
    const items = dataTransfer.items ? [...dataTransfer.items] : [];
    if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry();
        if (!entry) continue;
        out.push(...await collectFilesFromEntry(entry, ''));
      }
      if (out.length) return out;
    }
    for (const file of dataTransfer.files) out.push({ file, relDir: '' });
    return out;
  }
  // ---- end lifted block ----

  async function uploadOsDrop(dataTransfer, destDir) {
    const uploads = await collectOsDropUploads(dataTransfer);
    const groups = new Map();
    for (const u of uploads) {
      const d = u.relDir ? joinPath(destDir, u.relDir.replace(/\/+$/, '')) : (destDir || '');
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(u.file);
    }
    for (const [d, fs] of groups) await uploadFiles(fs, d);
  }

  // ---------- drag-to-move + OS drop targets ----------
  function clearDragOver() {
    document.querySelectorAll('.we-tree .drag-over').forEach((el) => el.classList.remove('drag-over'));
  }

  function bindDnD(tree) {
    tree.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.we-file, summary[data-type="dir"]');
      if (!row) return;
      e.dataTransfer.setData('application/ws-path', row.dataset.path);
      e.dataTransfer.setData('application/ws-type', row.dataset.type);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    tree.addEventListener('dragend', (e) => {
      const row = e.target.closest('.we-file, summary[data-type="dir"]');
      if (row) row.classList.remove('dragging');
      clearDragOver();
    });
    const destOf = (e) => {
      const sum = e.target.closest('summary[data-type="dir"]');
      return sum ? { el: sum, dir: sum.dataset.path } : { el: tree, dir: '' };
    };
    tree.addEventListener('dragover', (e) => {
      if (!isMoveDrag(e) && !isOsFilesDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isOsFilesDrag(e) ? 'copy' : 'move';
      clearDragOver();
      const { el } = destOf(e);
      if (el !== tree) el.classList.add('drag-over');
    });
    tree.addEventListener('dragleave', (e) => {
      if (!tree.contains(e.relatedTarget)) clearDragOver();
    });
    tree.addEventListener('drop', async (e) => {
      const os = isOsFilesDrag(e), mv = isMoveDrag(e);
      if (!os && !mv) return;
      e.preventDefault();
      clearDragOver();
      const { dir } = destOf(e);
      if (os) { await uploadOsDrop(e.dataTransfer, dir); return; }
      const src = e.dataTransfer.getData('application/ws-path');
      if (!src || src === dir || parentDir(src) === dir) return;
      try {
        await post('/api/workspace/move', { path: src, dest_dir: dir });
        toast('Moved ' + baseName(src));
        load(true);
      } catch (err) { toast('Move failed: ' + err.message); }
    });
  }

  // ---------- artifacts ----------
  function harvest(frame) {
    const text = [frame.tool, frame.command, frame.output]
      .filter((s) => typeof s === 'string').join(' ');
    if (!text) return;
    const tokens = text.match(/[\w][\w.\-\/]{2,}/g) || [];
    for (let t of tokens) {
      t = t.replace(/^\.\//, '').replace(/[.,;:)\]]+$/, '');
      if (state.root && t.startsWith(state.root + '/')) t = t.slice(state.root.length + 1);
      if (!t || t.length > 300) continue;
      state.pending.add(t);
    }
    if (state.pending.size > 500) {
      // bound memory: Sets iterate in insertion order, drop the oldest
      const it = state.pending.values();
      while (state.pending.size > 300) state.pending.delete(it.next().value);
    }
    matchPending();
    if (frame.type === 'tool_output' &&
        /write|edit|patch|save|mkdir|touch|tee|create|apply|mv |cp /i.test(text)) {
      scheduleRefresh();
    }
  }

  function matchPending() {
    let added = false;
    for (const t of state.pending) {
      if (!state.knownFiles.has(t)) continue;
      state.pending.delete(t);
      if (!state.artifacts.some((a) => a.path === t)) {
        state.artifacts.unshift({ path: t });
        added = true;
      }
    }
    if (added) renderArtifacts();
  }

  function renderArtifacts() {
    const list = document.getElementById('we-artifacts');
    const count = document.getElementById('we-art-count');
    if (count) count.textContent = String(state.artifacts.length);
    if (!list) return;
    list.innerHTML = state.artifacts.length
      ? state.artifacts.map((a) =>
          `<div class="we-artifact" data-path="${esc(a.path)}">` +
          `<span class="we-name">${esc(baseName(a.path))}</span>` +
          `<span class="we-art-dir">${esc(parentDir(a.path) || '/')}</span></div>`).join('')
      : '<div class="we-empty">No files touched this session yet</div>';
  }

  function setTab(tab) {
    state.tab = tab;
    document.getElementById('we-tab-files').classList.toggle('active', tab === 'files');
    document.getElementById('we-tab-artifacts').classList.toggle('active', tab === 'artifacts');
    document.getElementById('we-tree').hidden = tab !== 'files';
    document.getElementById('we-artifacts').hidden = tab !== 'artifacts';
  }

  function scheduleRefresh() {
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => load(true), 4000);
  }

  // ---------- panel resize ----------
  function initResize(pane) {
    const saved = parseInt(localStorage.getItem(LS_WIDTH) || '', 10);
    if (saved >= 200 && saved <= 600) pane.style.width = saved + 'px';
    const handle = document.getElementById('we-resize');
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX, startW = pane.offsetWidth;
      const move = (ev) => {
        const w = Math.min(600, Math.max(200, startW + (startX - ev.clientX)));
        pane.style.width = w + 'px';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        localStorage.setItem(LS_WIDTH, String(pane.offsetWidth));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
    });
  }

  // ---------- init ----------
  function init() {
    const pane = document.getElementById('workspace-explorer');
    if (!pane) return;
    const tree = document.getElementById('we-tree');
    document.getElementById('we-refresh').addEventListener('click', () => load(true));
    document.getElementById('we-collapse').addEventListener('click', () => {
      localStorage.setItem(LS_COLLAPSED, '1'); applyCollapsed();
    });
    document.getElementById('we-reopen').addEventListener('click', () => {
      localStorage.setItem(LS_COLLAPSED, '0'); applyCollapsed();
    });
    const uploadInput = document.getElementById('we-upload-input');
    document.getElementById('we-upload').addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', () => {
      uploadFiles([...uploadInput.files], '');
      uploadInput.value = '';
    });
    document.getElementById('we-new-file').addEventListener('click', () => doCreate('', false));
    document.getElementById('we-new-folder').addEventListener('click', () => doCreate('', true));
    document.getElementById('we-prefs').addEventListener('click', (e) => {
      e.stopPropagation();
      showPrefs(e.currentTarget);
    });
    document.getElementById('we-tab-files').addEventListener('click', () => setTab('files'));
    document.getElementById('we-tab-artifacts').addEventListener('click', () => setTab('artifacts'));
    document.getElementById('we-artifacts').addEventListener('click', (e) => {
      const a = e.target.closest('.we-artifact');
      if (a) openFile(a.dataset.path);
    });

    tree.addEventListener('click', (e) => {
      if (_suppressClick) {
        _suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const f = e.target.closest('.we-file');
      if (f) openFile(f.dataset.path);
    });
    // 'toggle' doesn't bubble, but capture sees it on the container.
    tree.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d || d.tagName !== 'DETAILS' || !d.dataset.path) return;
      if (!state.expanded) {
        // First explicit toggle: materialize saved state from the current DOM.
        state.expanded = new Set([...tree.querySelectorAll('details[open]')]
          .map((x) => x.dataset.path).filter(Boolean));
      }
      if (d.open) state.expanded.add(d.dataset.path);
      else state.expanded.delete(d.dataset.path);
      saveExpanded();
    }, true);
    tree.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.we-file, summary[data-type="dir"]');
      if (!row) return;
      e.preventDefault();
      showMenu(itemFromRow(row), e.clientX, e.clientY);
    });
    bindLongPress(tree);
    bindDnD(tree);
    initResize(pane);
    window.addEventListener('workspace:toolframe', (e) => harvest(e.detail || {}));
    window.addEventListener('workspace:session-switch', () => {
      state.artifacts = [];
      state.pending.clear();
      renderArtifacts();
      setTab('files');
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    renderArtifacts();
    load(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
```

- [ ] **Step 2: Syntax check** (IIFE, plain script — no `--input-type` needed)

Run: `cd /Users/admin/openclaw-workspace && node --check frontend-overrides/js/workspace-explorer.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/workspace-explorer.js
git commit -m "feat(explorer): file ops, context menu + long-press, upload/DnD, artifacts tab, hidden toggle, resize"
```

---

### Task 12: Sync, verify, hand to user

**Files:**
- Generated: `frontend/` (via `scripts/sync-frontend.sh` — stamps `sw.js` CACHE_NAME from the asset hash automatically; never edit `frontend/` by hand)

- [ ] **Step 1: Full backend test suite** (not just this module — catch collateral)

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/ -q`
Expected: all pass

- [ ] **Step 2: Sync frontend**

Run: `cd /Users/admin/openclaw-workspace && bash scripts/sync-frontend.sh`
Expected output includes: `stamped sw.js CACHE_NAME = gary-<newhash>` (proves cache bust)

- [ ] **Step 3: Curl byte checks against the live server** (frontend statics serve from disk immediately; the new APIs stay 404 until the user-gated restart)

```bash
curl -s http://127.0.0.1:8800/static/js/workspace-explorer.js | grep -c 'we-menu'
curl -s http://127.0.0.1:8800/static/hermes.css | grep -c 'we-dialog-overlay'
curl -s http://127.0.0.1:8800/ | grep -c 'we-tab-artifacts'
```

Expected: each ≥ 1

- [ ] **Step 4: Check nothing tracked is left uncommitted** (`frontend/` is gitignored build output)

```bash
cd /Users/admin/openclaw-workspace && git status --short
```

- [ ] **Step 5: Report to user.** Tell them:
  1. All explorer endpoints + controls are implemented and tested; frontend is synced and live-served.
  2. The pane (and every new control) activates at the **already-pending workspace LaunchAgent restart** — their call, never ours (2014 mini: one restart, 4-5 min cold boot).
  3. After restart, eyeball-verify on the 8443 origin: tree renders → right-click a file (Rename / Move to… / Copy path / Download / Delete) → ⋯ toggle hidden files → upload a file → drag a file onto a folder → Artifacts tab populates during an agent turn → drag the left edge to resize. On iPad: long-press a row for the menu. (Phone viewports ≤1100px hide the pane entirely — pre-existing media query, unchanged.)

---

## Post-restart verification checklist (user-gated)

- [ ] `curl -s http://127.0.0.1:8800/api/workspace/tree | python3 -m json.tool | head` shows a `dirty` key
- [ ] Tree renders; hidden files absent by default; ⋯ → "Show hidden files" reveals dotfiles and the eye indicator
- [ ] Right-click rename keeps the extension deselected (stem select)
- [ ] Delete shows danger confirm; folder delete says "everything inside it"
- [ ] Upload button + Finder drag-drop both land files (collision gets ` (1)`)
- [ ] Drag file onto folder moves it; move into `.git` impossible (400 toast)
- [ ] Artifacts tab counts up during an agent turn that touches workspace files
- [ ] Panel resizes 200-600px and the width survives reload
