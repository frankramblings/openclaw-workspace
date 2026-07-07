# Message-level Branch + Edit — Implementation Plan (revised for B+D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-message "Branch conversation here" (all messages) and "Edit last message" (Frank's most-recent user message, until the send buffer flushes) to the Workspace PWA chat surface.

**Architecture (revised after gateway probe):**

- **Branch = Option B (client-rendered prefix + first-turn context enrichment).**
  The gateway's `chat.inject` forces every message to render as an assistant bubble
  (no `role` field on the schema, handler always calls
  `appendAssistantTranscriptMessage`), so per-message replay is off the table.
  Instead: the backend just creates a new session inheriting model/endpoint/speed
  from the source, stores the prefix's message ids as "pending context" server-side,
  and returns the new session id + the prefix payload. The frontend renders the
  prefix bubbles from the source session's already-loaded cache. On Frank's first
  send into the new session, the workspace backend prepends a compact "prior
  context" preamble to the outgoing text before calling `chat.send`, then clears
  the pending-context record. Gary sees one enriched first user turn; the client
  renders the visible transcript from cache above it. Original session untouched.

- **Edit = Option D (client-side 700 ms send buffer).**
  Composer holds the send locally for ~700 ms with a subtle countdown ring on the
  optimistic bubble. During that window, tapping Edit swaps the bubble to a
  textarea; Save updates the pending payload and fires the send at buffer end (or
  immediately on ⌘/Ctrl+Enter after the ring closes). No backend edit endpoint, no
  `chat.abort` + reissue, no server-side state machine. After the buffer flushes,
  the pencil affordance disappears; no further edit is possible.

**Tech Stack:** Python (aiohttp) backend in `/home/frank/openclaw-workspace/backend/`;
vanilla-ES6 frontend overrides in `/home/frank/openclaw-workspace/frontend-overrides/js/redesign/`
(desktop) and `.../redesign/mobile/` (mobile). Gateway RPC over WebSocket via
`backend/bridge.py`.

## Global Constraints

- Repo root: `/home/frank/openclaw-workspace`. Always work from there. The vault at `/home/frank/.openclaw/workspace/` is a different tree — do not edit it.
- Backend runs as systemd user unit `openclaw-workspace.service`. Restart after backend changes: `systemctl --user restart openclaw-workspace.service`.
- Frontend served bundle is generated. Edit `frontend-overrides/`, then regen with `scripts/sync-frontend.sh`.
- **No new gateway RPCs.** Only use existing ones: `chat.send`, `chat.abort`, `chat.history`, `chat.metadata`, `chat.startup`. **Do NOT depend on `chat.inject`'s role field** — the probe (see Task 1 notes) confirmed it always renders as assistant.
- No new schema migrations. Pending-context is workspace-side JSON, one small file per branched session.
- Reference spec: `docs/superpowers/specs/2026-07-07-msg-branch-and-edit-design.md` (design intent) — but the concrete paths in this plan supersede the spec's "clean-path" sections after probe findings.

---

## File Structure

**Backend:**
- Create: `backend/branch_context.py` — pending-context store (~80 loc): write, read, consume-once. One small JSON file per branched session under `data/branch_context/<session_id>.json`.
- Create: `backend/tests/test_branch_context.py`
- Create: `backend/tests/test_session_branch.py`
- Modify: `backend/app.py` — add `POST /api/session/branch`; hook composer submit path to consume pending context and prepend a preamble on the first send after branch.

**Frontend (desktop):**
- Modify: `frontend-overrides/js/redesign/icons.js` — add `I.branch(size)` and `I.edit(size)` SVG helpers.
- Modify: `frontend-overrides/js/redesign/surfaces.js` — `msgTools(m, openId, ctx)` renders Branch (always) and Edit (predicate); `chatMsg` renders "carried-over" prefix bubbles from `session.branchPrefix` when present.
- Modify: `frontend-overrides/js/redesign/composer.js` (or wherever composer submit lives — search for `chat.send` call site) — add 700 ms send-buffer with countdown ring; enable in-place edit while buffered.
- Modify: `frontend-overrides/js/redesign/app.js` — three new action handlers: `branchFromMessage`, `editMessage` (opens inline textarea in composer, not on a persisted bubble), `saveEdit` (updates buffered payload).
- Create: `frontend-overrides/js/__tests__/msg-tools.test.js`

**Frontend (mobile):**
- Modify: `frontend-overrides/js/redesign/mobile/mobile-surfaces.js` — add Branch (always) and Edit (predicated) rows to the message action sheet; Edit only applies to the optimistic-not-yet-sent bubble.

---

## Task 1: Probe verdict note (record what we already learned)

The gateway probe already ran in the prior session. This task captures those findings as a persistent artifact so downstream tasks can reference them without re-probing.

**Files:**
- Create: `docs/superpowers/notes/2026-07-07-gateway-probe.md`

**Interfaces:**
- Consumes: nothing
- Produces: the note. Referenced by Tasks 2, 4, 5.

- [ ] **Step 1: Write the note**

Create `docs/superpowers/notes/2026-07-07-gateway-probe.md`:

```markdown
# Gateway probe — msg branch/edit (2026-07-07)

## Findings

1. **`chat.inject` role param is not honored.**
   The RPC schema does not accept `role`; the handler unconditionally calls
   `appendAssistantTranscriptMessage`. Injected messages render as **assistant**
   bubbles regardless. Per-message prefix replay is not viable.

2. **`chat.abort` does not roll back the user turn.**
   After `chat.send` + immediate `chat.abort` with zero assistant tokens, the
   user message remains in the transcript. A subsequent `chat.send` with new
   text yields a two-user-turn history. The "reissue" path in the spec is
   therefore dirty.

3. **`chat.send` requires `idempotencyKey`.** (Ancillary — not blocking, but
   the current backend already threads this.)

4. **`chat.inject` requires the session to already exist gateway-side.**
   `sessions_store.create()` alone is not enough; the session materializes in
   the brain on the first `chat.send`. Any inject-based seed strategy would need
   a priming send first. Not a concern for the chosen path.

## Verdict

**FALLBACK: B + D.**

- **Branch = client-rendered prefix + first-turn context enrichment (B).**
  Do not attempt per-message inject. Store the prefix as pending context
  server-side; render the prefix from source-session cache client-side; prepend
  a preamble on Frank's first send.

- **Edit = client-side 700 ms send buffer (D).**
  Do not build the server-side edit endpoint or `message_edit.py`. Buffer
  entirely in the composer; edit is a UI affordance on the pre-send optimistic
  bubble only.
```

- [ ] **Step 2: Commit**

```bash
cd /home/frank/openclaw-workspace
git add docs/superpowers/notes/2026-07-07-gateway-probe.md
git commit -m "notes: gateway probe verdict for msg branch/edit (B+D)"
```

---

## Task 2: `backend/branch_context.py` — pending-context store

A tiny persistent store keyed by new-session-id. Holds the prefix messages that
the frontend renders above the composer, plus a compact serialization the backend
will use to build the first-send preamble.

**Files:**
- Create: `backend/branch_context.py`
- Create: `backend/tests/test_branch_context.py`
- Create (empty at first): `data/branch_context/` (directory)

**Interfaces:**
- Consumes: stdlib (`json`, `pathlib`, `os`).
- Produces:
  - `def write(new_session_id: str, source_session_id: str, prefix: list[dict], preamble: str) -> None` — persist one JSON file per new session; overwrites if present.
  - `def read(new_session_id: str) -> dict | None` — returns `{"source_session_id", "prefix", "preamble"}` or `None`.
  - `def consume(new_session_id: str) -> dict | None` — read + delete atomically. Called by app.py on the first `chat.send` after branch.
  - Consumers: Task 3 (branch endpoint) writes; Task 4 (composer hook) consumes.

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_branch_context.py`:

```python
import os, pytest, tempfile, importlib
from pathlib import Path

@pytest.fixture
def bc(monkeypatch):
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("OPENCLAW_BRANCH_CONTEXT_DIR", tmp)
    from backend import branch_context
    importlib.reload(branch_context)
    return branch_context

def test_write_then_read_roundtrips(bc):
    prefix = [{"id": "m1", "role": "user", "text": "hi"}]
    bc.write("new-1", "src-1", prefix, "prior: hi")
    got = bc.read("new-1")
    assert got is not None
    assert got["source_session_id"] == "src-1"
    assert got["prefix"] == prefix
    assert got["preamble"] == "prior: hi"

def test_read_missing_returns_none(bc):
    assert bc.read("nope") is None

def test_consume_returns_and_deletes(bc):
    bc.write("new-2", "src-2", [], "p")
    first = bc.consume("new-2")
    second = bc.consume("new-2")
    assert first is not None
    assert second is None

def test_consume_missing_returns_none(bc):
    assert bc.consume("nope") is None
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /home/frank/openclaw-workspace && python3 -m pytest backend/tests/test_branch_context.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.branch_context'`.

- [ ] **Step 3: Implement `branch_context.py`**

Create `backend/branch_context.py`:

```python
"""Pending-context store for message-level Branch.

When a new session is branched from an existing one, we cannot replay the
prefix into the gateway (chat.inject renders everything as assistant). Instead
we hold the prefix here, workspace-side. The frontend renders the prefix from
the source session's cache; when Frank sends his first message into the new
session, the composer path calls consume() and prepends a compact preamble to
Frank's outgoing text so Gary has the context.

One JSON file per branched new-session id. Override the directory in tests via
env var OPENCLAW_BRANCH_CONTEXT_DIR.
"""
from __future__ import annotations
import json, os, tempfile
from pathlib import Path

_DEFAULT_DIR = Path(__file__).resolve().parent.parent / "data" / "branch_context"


def _dir() -> Path:
    override = os.environ.get("OPENCLAW_BRANCH_CONTEXT_DIR")
    p = Path(override) if override else _DEFAULT_DIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def _path(new_session_id: str) -> Path:
    safe = new_session_id.replace("/", "_")
    return _dir() / f"{safe}.json"


def write(new_session_id: str, source_session_id: str,
          prefix: list[dict], preamble: str) -> None:
    payload = {"source_session_id": source_session_id,
               "prefix": prefix, "preamble": preamble}
    p = _path(new_session_id)
    # atomic write
    fd, tmp = tempfile.mkstemp(prefix=".ctx-", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read(new_session_id: str) -> dict | None:
    p = _path(new_session_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def consume(new_session_id: str) -> dict | None:
    p = _path(new_session_id)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    try:
        p.unlink()
    except OSError:
        pass
    return data
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /home/frank/openclaw-workspace && python3 -m pytest backend/tests/test_branch_context.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
mkdir -p data/branch_context
touch data/branch_context/.gitkeep
git add backend/branch_context.py backend/tests/test_branch_context.py data/branch_context/.gitkeep
git commit -m "backend: branch_context store for pending-context (write/read/consume)"
```

---

## Task 3: `POST /api/session/branch` endpoint

Creates a new session inheriting model/endpoint/speed from source, computes the
prefix from source transcript up to `up_to_message_id` inclusive, builds a
preamble string, and hands both back to the client while persisting them for the
first-send hook.

**Files:**
- Modify: `backend/app.py` — add handler + route
- Create: `backend/tests/test_session_branch.py`

**Interfaces:**
- Consumes: `bridge.fetch_history`, `sessions_store.create`, `sessions_store.get`, `sessions_store.delete`, `branch_context.write`.
- Produces: `POST /api/session/branch` with form fields `source_session_id`, `up_to_message_id`, optional `name`, `model`, `speed`. Response `{"session_id": str, "session_key": str, "prefix": list[dict]}`. Called by frontend Task 6.

- [ ] **Step 1: Locate existing session-create HTTP handler**

Run: `cd /home/frank/openclaw-workspace && grep -n "sessions_store.create\|async def.*session\|add_post.*session" backend/app.py | head -30`

Read the surrounding handler to match its auth/parse/response conventions.

- [ ] **Step 2: Write failing tests**

Create `backend/tests/test_session_branch.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from aiohttp.test_utils import AioHTTPTestCase
from backend import app as backend_app, sessions_store, bridge, branch_context


class BranchTestCase(AioHTTPTestCase):
    async def get_application(self):
        return backend_app.build_app()

    async def test_branch_happy_path(self):
        src = sessions_store.create(name="src", model=None,
                                    endpoint_url=None, endpoint_id=None, speed=None)
        history = [
            {"id": "m1", "role": "user", "text": "hi"},
            {"id": "m2", "role": "assistant", "text": "hello"},
            {"id": "m3", "role": "user", "text": "next"},
        ]
        with patch.object(bridge, "fetch_history",
                          new=AsyncMock(return_value=history)):
            resp = await self.client.post("/api/session/branch", data={
                "source_session_id": src["id"],
                "up_to_message_id": "m2",
            })
            assert resp.status == 200
            body = await resp.json()
            assert "session_id" in body and body["session_id"] != src["id"]
            assert len(body["prefix"]) == 2
            assert body["prefix"][0]["id"] == "m1"
            # Persisted for first-send hook
            ctx = branch_context.read(body["session_id"])
            assert ctx is not None
            assert "hi" in ctx["preamble"]
            assert "hello" in ctx["preamble"]
        sessions_store.delete(src["id"])
        sessions_store.delete(body["session_id"])

    async def test_branch_missing_message_id_is_404(self):
        src = sessions_store.create(name="src2", model=None,
                                    endpoint_url=None, endpoint_id=None, speed=None)
        with patch.object(bridge, "fetch_history",
                          new=AsyncMock(return_value=[{"id": "m1", "role": "user", "text": "hi"}])):
            resp = await self.client.post("/api/session/branch", data={
                "source_session_id": src["id"],
                "up_to_message_id": "nope",
            })
            assert resp.status == 404
        sessions_store.delete(src["id"])

    async def test_branch_missing_source_is_404(self):
        resp = await self.client.post("/api/session/branch", data={
            "source_session_id": "no-such-session",
            "up_to_message_id": "m1",
        })
        assert resp.status == 404
```

- [ ] **Step 3: Run tests to verify failure**

Run: `cd /home/frank/openclaw-workspace && python3 -m pytest backend/tests/test_session_branch.py -v`
Expected: FAIL — endpoint not routed.

- [ ] **Step 4: Implement the endpoint**

Add to `backend/app.py` (near other session HTTP handlers):

```python
from . import branch_context  # top-of-file with other imports

def _build_preamble(prefix: list[dict]) -> str:
    """Compact serialization of the branched-from transcript prefix, used as
    the first-send context preamble. Kept short: role + text, one per line."""
    lines = []
    for m in prefix:
        role = (m.get("role") or "user").strip()
        text = (m.get("text") or m.get("content") or "").strip()
        if not text:
            continue
        who = "Frank" if role == "user" else "Gary"
        lines.append(f"{who}: {text}")
    body = "\n".join(lines)
    return (
        "For context, this conversation was branched from an earlier thread. "
        "Here is what was said before, verbatim:\n\n"
        f"{body}\n\n"
        "Continue from here."
    )


async def _api_session_branch(request):
    """POST /api/session/branch — create a new session and stash the transcript
    prefix as pending context. The frontend renders the prefix client-side; the
    next composer submit into this session will consume the pending context and
    prepend a preamble to the outgoing chat.send."""
    data = await request.post()
    src_id = (data.get("source_session_id") or "").strip()
    upto = (data.get("up_to_message_id") or "").strip()
    if not src_id or not upto:
        return web.json_response({"error": "missing source_session_id or up_to_message_id"}, status=400)

    src = sessions_store.get(src_id)
    if src is None:
        return web.json_response({"error": "source session not found"}, status=404)

    hist = await bridge.fetch_history(src["sessionKey"], limit=1000)
    idx = None
    for i, m in enumerate(hist):
        if m.get("id") == upto:
            idx = i
            break
    if idx is None:
        return web.json_response({"error": "up_to_message_id not in transcript"}, status=404)
    prefix = hist[: idx + 1]

    name_override = (data.get("name") or "").strip()
    new_name = name_override or f"↳ {src.get('name') or 'chat'} — from msg {idx + 1}"
    new_sess = sessions_store.create(
        name=new_name,
        model=data.get("model") or src.get("model"),
        endpoint_url=src.get("endpoint_url"),
        endpoint_id=src.get("endpoint_id"),
        speed=data.get("speed") or src.get("speed"),
    )

    preamble = _build_preamble(prefix)
    branch_context.write(new_sess["id"], src_id, prefix, preamble)

    return web.json_response({
        "session_id": new_sess["id"],
        "session_key": new_sess["sessionKey"],
        "prefix": prefix,
    })
```

Register the route: `app.router.add_post("/api/session/branch", _api_session_branch)`

- [ ] **Step 5: Run tests to verify pass**

Run: `cd /home/frank/openclaw-workspace && python3 -m pytest backend/tests/test_session_branch.py -v`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
cd /home/frank/openclaw-workspace
git add backend/app.py backend/tests/test_session_branch.py
git commit -m "backend: POST /api/session/branch — stash prefix as pending context"
```

---

## Task 4: Hook composer submit to consume pending context on first send

On the first `chat.send` into a session that has a persisted branch context,
prepend the preamble to the outgoing text and clear the pending record. All
subsequent sends into that session pass through untouched.

**Files:**
- Modify: `backend/app.py` — composer/chat-stream submit path
- Create/append: `backend/tests/test_branch_first_send.py`

**Interfaces:**
- Consumes: `branch_context.consume`, existing composer text extraction, existing `bridge.stream_turn` (or whatever the current send path is).
- Produces: no new external API; changes the payload of the first `chat.send` after branch.

- [ ] **Step 1: Locate the composer submit → chat.send path**

Run: `cd /home/frank/openclaw-workspace && grep -n "stream_turn\|chat_stream\|composer\|send.*message" backend/app.py | head -30`

Read the relevant lines to find where `session_id` + the outgoing user text are known but the `chat.send` (or `stream_turn`) call has not yet fired.

- [ ] **Step 2: Write failing test**

Create `backend/tests/test_branch_first_send.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from backend import app as backend_app, branch_context, sessions_store

@pytest.mark.asyncio
async def test_first_send_after_branch_prepends_preamble(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCLAW_BRANCH_CONTEXT_DIR", str(tmp_path))
    import importlib
    from backend import branch_context as bc_mod
    importlib.reload(bc_mod)

    sess = sessions_store.create(name="branched", model=None,
                                 endpoint_url=None, endpoint_id=None, speed=None)
    bc_mod.write(sess["id"], "src-1",
                 [{"id": "m1", "role": "user", "text": "hello"}],
                 "For context, this conversation was branched from an earlier thread...")

    captured = {}
    async def fake_stream_turn(text, *args, **kwargs):
        captured["text"] = text
        if False:
            yield  # make it a generator
        return
    # Call whatever helper wraps chat.send from the composer path. Adjust the
    # target of monkeypatch to match app.py's actual send entrypoint.
    from backend import bridge
    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)

    outgoing = await backend_app._compose_outgoing_for_session(sess["id"], "next")
    assert outgoing.startswith("For context")
    assert outgoing.endswith("next")
    # Second call: context is gone
    outgoing2 = await backend_app._compose_outgoing_for_session(sess["id"], "again")
    assert outgoing2 == "again"

    sessions_store.delete(sess["id"])
```

(If the actual send handler doesn't have a clean seam like `_compose_outgoing_for_session`, extract one during implementation — see Step 3.)

- [ ] **Step 3: Extract a compose seam and wire it**

In `backend/app.py`, at the composer path, extract a small helper:

```python
async def _compose_outgoing_for_session(session_id: str, user_text: str) -> str:
    """Consume any pending branch-context for this session and prepend its
    preamble to the outgoing text. Idempotent per session: only the first
    call after a branch prepends; all subsequent calls return user_text as-is."""
    ctx = branch_context.consume(session_id)
    if not ctx:
        return user_text
    preamble = ctx.get("preamble") or ""
    return f"{preamble}\n\nFrank: {user_text}" if preamble else user_text
```

Call it at the composer submit site, replacing the direct use of the raw user text with the composed string when invoking `bridge.stream_turn`/`chat.send`.

- [ ] **Step 4: Run tests**

Run: `cd /home/frank/openclaw-workspace && python3 -m pytest backend/tests/test_branch_first_send.py -v`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add backend/app.py backend/tests/test_branch_first_send.py
git commit -m "backend: consume branch context on first send after branch"
```

---

## Task 5: Frontend icons + `msgTools` extension (Branch always; Edit predicated)

Add SVG icons; extend per-message hover toolbar to render Branch on all messages
and Edit only on the current optimistic-not-yet-sent bubble (predicate lives on
the composer-owned pending message, not on persisted transcript messages).

**Files:**
- Modify: `frontend-overrides/js/redesign/icons.js`
- Modify: `frontend-overrides/js/redesign/surfaces.js`
- Create: `frontend-overrides/js/__tests__/msg-tools.test.js`

**Interfaces:**
- Consumes: existing `I.copy` / `I.download` icon-helper pattern; existing `chatMsg(m, s)` renderer.
- Produces:
  - `I.branch(size: number): string` and `I.edit(size: number): string`.
  - `msgTools(m, openId, ctx)` — `ctx = { canEdit: bool }`. `canEdit` is set true by the caller **only** for the optimistic pending-send bubble that has an active send-buffer timer (introduced in Task 7). Persisted transcript messages always render `canEdit: false`.
  - Consumed by Task 7 (composer buffer) and Task 8 (action handlers).

- [ ] **Step 1: Add icon helpers**

In `frontend-overrides/js/redesign/icons.js`, after the existing `I.copy` / `I.download` helpers, add matching-style entries:

```javascript
I.branch = (size = 14) => svgWrap(size,
  '<path d="M6 3v6M18 9a3 3 0 100 6 3 3 0 000-6zM6 3a3 3 0 100 6 3 3 0 000-6zM6 15v6M6 15a3 3 0 100 6 3 3 0 000-6zM18 15a6 6 0 01-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');

I.edit = (size = 14) => svgWrap(size,
  '<path d="M4 20h4l10-10-4-4L4 16v4z M14 6l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>');
```

If `svgWrap` isn't the actual helper name in this file, read the file and match the surrounding pattern.

- [ ] **Step 2: Extend `msgTools`**

Modify the `msgTools` function in `frontend-overrides/js/redesign/surfaces.js`:

```javascript
function msgTools(m, openId, ctx) {
  const open = openId === m.id;
  const canEdit = !!(ctx && ctx.canEdit && m.role === 'user');
  // preserve the existing download-menu markup exactly — the snippet below
  // shows only the additions
  return `<div class="msg-tools">`
    + `<button class="msg-tool" data-act="copyMessage" data-arg="${esc(m.id)}" title="Copy message" aria-label="Copy message">${I.copy(15)}</button>`
    + `<button class="msg-tool" data-act="branchFromMessage" data-arg="${esc(m.id)}" title="Branch conversation here" aria-label="Branch here">${I.branch(15)}</button>`
    + (canEdit
        ? `<button class="msg-tool" data-act="editMessage" data-arg="${esc(m.id)}" title="Edit message" aria-label="Edit">${I.edit(15)}</button>`
        : '')
    + /* … existing download button and menu markup, unchanged … */
    + `</div>`;
}
```

- [ ] **Step 3: Pass `ctx.canEdit` from callers**

In `chatMsg` (same file), when rendering a message, compute:

```javascript
const canEdit = !!(s.live?.chat?.pendingSend
                 && s.live.chat.pendingSend.messageId === m.id);
const ctx = { canEdit };
// use msgTools(m, s.live?.chat?.msgMenuOpen, ctx)
```

(`s.live.chat.pendingSend` is introduced in Task 7 — safe to write now; the predicate is false until then.)

- [ ] **Step 4: Write Jest test**

Create `frontend-overrides/js/__tests__/msg-tools.test.js`:

```javascript
import { chatMsg } from '../redesign/surfaces.js';

const base = { live: { chat: { messages: [
  { id: 'u1', role: 'user', text: 'hi', time: '10:00' },
  { id: 'a1', role: 'assistant', text: 'hello', time: '10:00' },
  { id: 'u2', role: 'user', text: 'next', time: '10:01' },
], pendingSend: null } } };

test('any message has branch button', () => {
  expect(chatMsg(base.live.chat.messages[0], base)).toContain('data-act="branchFromMessage"');
  expect(chatMsg(base.live.chat.messages[1], base)).toContain('data-act="branchFromMessage"');
  expect(chatMsg(base.live.chat.messages[2], base)).toContain('data-act="branchFromMessage"');
});

test('no message has edit when nothing is pending', () => {
  expect(chatMsg(base.live.chat.messages[2], base)).not.toContain('data-act="editMessage"');
});

test('pending-send bubble has edit', () => {
  const s = { live: { chat: { ...base.live.chat,
    messages: [...base.live.chat.messages, { id: 'p1', role: 'user', text: 'draft', time: '10:02' }],
    pendingSend: { messageId: 'p1' } } } };
  expect(chatMsg({ id: 'p1', role: 'user', text: 'draft', time: '10:02' }, s))
    .toContain('data-act="editMessage"');
});
```

- [ ] **Step 5: Run Jest**

Run: `cd /home/frank/openclaw-workspace && npx jest frontend-overrides/js/__tests__/msg-tools.test.js`
Expected: 3 passed. If Jest isn't configured, either add a minimal config or convert to `node --test`.

- [ ] **Step 6: Regen bundle + commit**

```bash
cd /home/frank/openclaw-workspace
./scripts/sync-frontend.sh
git add frontend-overrides/js/redesign/icons.js \
        frontend-overrides/js/redesign/surfaces.js \
        frontend-overrides/js/__tests__/msg-tools.test.js \
        frontend/
git commit -m "frontend: branch + edit icons and msgTools predicate scaffolding"
```

---

## Task 6: Frontend — render prefix bubbles for branched sessions

When a session was just branched (or is re-opened and its `branchPrefix` is
loaded from local storage/server), render the prefix messages above the live
transcript as normal-looking chat bubbles that the user can hover, copy, and
branch from — but that came from the source session's cache, not from
`chat.history`.

**Files:**
- Modify: `frontend-overrides/js/redesign/app.js` — `branchFromMessage` action populates `session.branchPrefix` from the response.
- Modify: `frontend-overrides/js/redesign/surfaces.js` — message-list renderer concatenates `branchPrefix` (styled subtly as "carried over") in front of the live `messages` array.

**Interfaces:**
- Consumes: `POST /api/session/branch` response (from Task 3); session-state helpers.
- Produces: `session.branchPrefix: list[dict]` client-side state. Rendered by `chatMsg` list.

- [ ] **Step 1: Locate message-list render loop**

Run: `cd /home/frank/openclaw-workspace && grep -n "messages.map\|chatMsg(\|live.chat.messages" frontend-overrides/js/redesign/surfaces.js | head`

- [ ] **Step 2: Extend the render loop**

Where the loop currently renders `s.live.chat.messages`, change it to:

```javascript
const prefix = s.branchPrefix || [];
const live = s.live?.chat?.messages || [];
const combined = [...prefix.map(m => ({ ...m, _carried: true })), ...live];
combined.map(m => chatMsg(m, s)).join('');
```

Then in `chatMsg`, if `m._carried`, add a subtle class `msg-carried` for CSS styling (slightly lower contrast, tiny "from earlier thread" caption on the first one).

- [ ] **Step 3: Populate `branchPrefix` on branch action**

In `app.js`, the new `branchFromMessage` handler (added in Task 8) will set `newSession.branchPrefix = response.prefix`. For persistence across reloads, also cache under `localStorage['branchPrefix:'+sessionId]` and rehydrate on session-open. Delete the localStorage entry once the session has ≥1 real message from `chat.history` (i.e., the first send has completed and `chat.history` will now show Frank's context-enriched turn plus Gary's reply).

- [ ] **Step 4: Add "carried" styling**

In the same CSS file that styles `.msg-tools`, add:

```css
.msg-carried { opacity: 0.72; }
.msg-carried::before {
  /* only show once, on the first carried message — controlled via a
     .msg-carried-first class added by the renderer to the first item */
  display: none;
}
.msg-carried-first { position: relative; }
.msg-carried-first::before {
  content: "↳ carried from source thread";
  display: block;
  font-size: 11px;
  color: var(--muted, #888);
  margin: 12px 0 6px;
  text-align: center;
  letter-spacing: 0.02em;
}
```

Adjust the renderer to tag the first carried message with `msg-carried-first`.

- [ ] **Step 5: Commit (no runtime test yet — covered in Task 9 e2e)**

```bash
cd /home/frank/openclaw-workspace
./scripts/sync-frontend.sh
git add frontend-overrides/ frontend/
git commit -m "frontend: render carried prefix bubbles above live transcript in branched sessions"
```

---

## Task 7: Composer send-buffer (client-side, 700 ms)

Turn composer submit into a two-phase op: (1) render optimistic bubble, start
700 ms countdown; (2) actually POST to `chat_stream` at buffer end (or immediately
if Frank hits Save on a mid-edit). While the timer runs, the bubble has an
Edit affordance (via Task 5's `canEdit` predicate).

**Files:**
- Modify: `frontend-overrides/js/redesign/composer.js` (or the file that owns the composer submit — locate first)
- Modify: `frontend-overrides/js/redesign/surfaces.js` — optimistic-bubble render includes a countdown ring
- Modify: `frontend-overrides/js/redesign/icons.js` — small progress-ring helper if not already present

**Interfaces:**
- Consumes: existing composer submit flow (whatever function calls fetch to `/api/chat_stream`).
- Produces:
  - `s.live.chat.pendingSend = { messageId, text, deadline } | null` — set on submit, cleared on flush/cancel.
  - `flushPending(sessionId)` — internal helper: cancels timer, POSTs the current pending text, clears state.

- [ ] **Step 1: Locate composer submit**

Run: `cd /home/frank/openclaw-workspace && grep -rn "chat_stream\|composerSubmit\|sendMessage(" frontend-overrides/js/redesign/ | head -20`

- [ ] **Step 2: Refactor submit into buffered flow**

At the existing submit site, replace direct-fire logic with:

```javascript
const BUFFER_MS = 700;

function submitFromComposer(sessionId, text) {
  const messageId = genClientMsgId(); // reuse the existing helper
  const chat = getActiveSessionState().live.chat;
  const optimistic = { id: messageId, role: 'user', text, time: nowLabel(),
                       _optimistic: true, _deadline: Date.now() + BUFFER_MS };
  chat.messages.push(optimistic);
  chat.pendingSend = { messageId, text, deadline: optimistic._deadline,
                       timerId: null };
  rerender();
  chat.pendingSend.timerId = setTimeout(() => flushPending(sessionId), BUFFER_MS);
}

function flushPending(sessionId) {
  const chat = getSession(sessionId).live.chat;
  const p = chat.pendingSend;
  if (!p) return;
  clearTimeout(p.timerId);
  chat.pendingSend = null;
  // Fire the real send with the (possibly edited) text.
  actuallyPostChatStream(sessionId, p.messageId, p.text);
  rerender();
}
```

`actuallyPostChatStream` is the existing fetch to `/api/chat_stream` — unchanged.

- [ ] **Step 3: Countdown ring on optimistic bubble**

In the message-body renderer, when `m._optimistic`, add a small ring next to the timestamp:

```javascript
if (m._optimistic && m._deadline) {
  const remaining = Math.max(0, m._deadline - Date.now());
  const pct = Math.max(0, Math.min(1, remaining / 700));
  html += `<span class="msg-pending-ring" style="--pct:${pct}"></span>`;
}
```

And CSS (in the msg-tools CSS file):

```css
.msg-pending-ring {
  display: inline-block; width: 10px; height: 10px; margin-left: 6px;
  border-radius: 50%;
  background: conic-gradient(var(--accent, #4a90e2) calc(var(--pct) * 360deg), transparent 0);
  vertical-align: middle;
}
```

Kick a `requestAnimationFrame` loop while any `pendingSend` exists so the ring visibly drains. Stop when it flushes.

- [ ] **Step 4: Manual smoke**

```bash
cd /home/frank/openclaw-workspace
./scripts/sync-frontend.sh
systemctl --user restart openclaw-workspace.service
```

Open PWA → send a message → verify 700 ms ring drains, then Gary starts replying. Verify normal messages still work.

- [ ] **Step 5: Commit**

```bash
cd /home/frank/openclaw-workspace
git add frontend-overrides/ frontend/
git commit -m "frontend: 700ms composer send-buffer with countdown ring"
```

---

## Task 8: Frontend action handlers — `branchFromMessage`, `editMessage`, `saveEdit`

Wire buttons to backend endpoints and to composer buffer state.

**Files:**
- Modify: `frontend-overrides/js/redesign/app.js`

**Interfaces:**
- Consumes: `msgTools` `data-act` dispatch; `selectSession(id)` helper; Task 7's `pendingSend` state and `flushPending`; `POST /api/session/branch`.
- Produces: three action-handler branches: `branchFromMessage`, `editMessage`, `saveEdit`.

- [ ] **Step 1: Locate action dispatch**

Run: `cd /home/frank/openclaw-workspace && grep -n "data-act\|dataset.act\|copyMessage" frontend-overrides/js/redesign/app.js | head -20`

- [ ] **Step 2: Add handlers**

```javascript
async function branchFromMessage(msgId) {
  const sess = getActiveSession();
  if (!sess) return;
  try {
    const fd = new FormData();
    fd.append('source_session_id', sess.id);
    fd.append('up_to_message_id', msgId);
    const r = await fetch('/api/session/branch', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`branch failed: ${r.status}`);
    const { session_id, prefix } = await r.json();
    await refreshSessions();
    // Stash the prefix so surfaces.js renders it above the (empty) live transcript
    const next = getSession(session_id);
    if (next) { next.branchPrefix = prefix; }
    try {
      localStorage.setItem(`branchPrefix:${session_id}`, JSON.stringify(prefix));
    } catch (_) {}
    selectSession(session_id);
  } catch (e) {
    toast(`Couldn't branch: ${e.message}`);
  }
}

function editMessage(msgId) {
  const chat = getActiveSessionState().live.chat;
  const p = chat.pendingSend;
  if (!p || p.messageId !== msgId) {
    // predicate should have prevented this, but be safe
    return;
  }
  const wrap = document.querySelector(`.msg-user-wrap[data-msg-id="${CSS.escape(msgId)}"] .msg-user`);
  if (!wrap) return;
  const ta = document.createElement('textarea');
  ta.className = 'msg-edit-ta';
  ta.value = p.text;
  ta.rows = Math.max(2, p.text.split('\n').length + 1);
  const bar = document.createElement('div');
  bar.className = 'msg-edit-bar';
  bar.innerHTML = `<button data-act="saveEdit" data-arg="${msgId}">Save & send</button>`
                + `<button data-act="cancelEdit" data-arg="${msgId}">Cancel</button>`;
  wrap.replaceChildren(ta, bar);
  ta.focus();
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveEdit(msgId);
    if (e.key === 'Escape') cancelEdit(msgId);
  });
}

function saveEdit(msgId) {
  const chat = getActiveSessionState().live.chat;
  const p = chat.pendingSend;
  if (!p || p.messageId !== msgId) {
    toast(`Too late to edit — Gary already started`);
    rerender();
    return;
  }
  const ta = document.querySelector(`.msg-user-wrap[data-msg-id="${CSS.escape(msgId)}"] .msg-edit-ta`);
  if (!ta) return;
  p.text = ta.value;
  // Update the optimistic message model so the re-render shows the new text
  const m = chat.messages.find(x => x.id === msgId);
  if (m) m.text = ta.value;
  // Flush immediately — Frank made his final call
  flushPending(getActiveSession().id);
}

function cancelEdit(msgId) {
  // Keep the pending send with the original text; just close the textarea
  rerender();
}
```

Wire into the existing click delegator's `switch`/`if` on `data-act`.

- [ ] **Step 3: Rehydrate `branchPrefix` on session open**

At the session-open path (search for where a session's state is loaded/materialized), read `localStorage['branchPrefix:'+sessionId]` and assign to `session.branchPrefix` if present. Delete on first live message arrival (via the existing `chat.history` handler — check `session.live.chat.messages.length > 0` and clear both `session.branchPrefix` and the localStorage key).

- [ ] **Step 4: Commit**

```bash
cd /home/frank/openclaw-workspace
./scripts/sync-frontend.sh
git add frontend-overrides/ frontend/
git commit -m "frontend: branchFromMessage + editMessage/saveEdit against composer buffer"
```

---

## Task 9: Mobile action-sheet parity

Add Branch (always) and Edit (only when the sheet's target message is the current
`pendingSend.messageId`) to the mobile per-message action sheet.

**Files:**
- Modify: `frontend-overrides/js/redesign/mobile/mobile-surfaces.js`
- Modify: `frontend-overrides/js/redesign/mobile/mobile-sheets.js` (if dispatch lives there)

**Interfaces:**
- Consumes: desktop `branchFromMessage`, `editMessage`, `saveEdit` from Task 8.
- Produces: Branch and Edit rows in the message action sheet.

- [ ] **Step 1: Locate mobile message action sheet**

Run: `cd /home/frank/openclaw-workspace && grep -n "copyMessage\|actionSheet\|msgSheet" frontend-overrides/js/redesign/mobile/*.js | head`

- [ ] **Step 2: Add rows**

Add "Branch here" (always) and "Edit" (conditional on `pendingSend.messageId === m.id`) in the same shape as the existing Copy row. Wire dispatch to the desktop handlers (reuse via import or via the shared window global the mobile code already uses).

- [ ] **Step 3: Manual mobile-viewport smoke**

Open PWA in narrow viewport (or real phone via `naboo.bicolor-triceratops.ts.net:8443`). Long-press message → sheet includes Branch. Long-press an in-flight optimistic bubble within 700 ms → sheet also includes Edit.

- [ ] **Step 4: Commit**

```bash
cd /home/frank/openclaw-workspace
./scripts/sync-frontend.sh
git add frontend-overrides/js/redesign/mobile/ frontend/
git commit -m "mobile: branch + edit rows in per-message action sheet"
```

---

## Task 10: End-to-end verification

Confirm both features work in the running PWA against the live gateway. Deploy left running.

**Files:** verification-only; may add a note.

- [ ] **Step 1: Full deploy**

```bash
cd /home/frank/openclaw-workspace
./scripts/sync-frontend.sh
systemctl --user restart openclaw-workspace.service
sleep 3
journalctl --user -u openclaw-workspace -n 30 --no-pager
```

Expected: no tracebacks.

- [ ] **Step 2: Branch e2e**

Open a chat with ≥3 messages. Hover message #2 → Branch. Verify:
- Sidebar shows new session `↳ <original> — from msg 2`.
- New session renders messages #1 + #2 as "carried" bubbles above an empty composer.
- Original session is unchanged.
- Send a message in the new session → Gary responds as if the prior turns really happened (context preamble prepended server-side).
- After the first turn completes, the "carried" caption is gone (localStorage cleaned; `chat.history` now populated with the enriched real turn).

- [ ] **Step 3: Edit e2e — inside buffer**

Send a message with a typo. During the ~700 ms ring, tap Edit → fix → Save & send. Verify:
- Only the corrected text is sent (Gary answers the corrected version).
- Transcript shows only the corrected text after the ring flushes.

- [ ] **Step 4: Edit e2e — after buffer flush**

Send a message, wait for the ring to complete (Gary starts replying). Verify:
- The pencil is gone.
- Long-press on desktop shows no Edit row.

- [ ] **Step 5: Cancel edit**

Send a message, tap Edit within the ring, hit Cancel. Verify the original text sends when the ring flushes.

- [ ] **Step 6: Record verification**

Create `docs/superpowers/notes/2026-07-07-msg-branch-edit-verification.md` — one paragraph, what worked, any surprises.

```bash
cd /home/frank/openclaw-workspace
git add docs/superpowers/notes/2026-07-07-msg-branch-edit-verification.md
git commit -m "notes: msg branch + edit e2e verification"
```
