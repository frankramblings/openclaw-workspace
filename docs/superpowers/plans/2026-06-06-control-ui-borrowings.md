# Control-UI Borrowings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six features borrowed from OpenClaw's stock Control UI: stop button, gateway restart/health awareness, session hygiene, thinking display, cron run history, skills toggles.

**Architecture:** Backend adapters in `backend/` (FastAPI, per-turn gateway WS via `bridge.py` + one new persistent monitor WS), frontend changes ONLY as self-contained overlay scripts in `frontend-overrides/` applied by `scripts/sync-frontend.sh`. chat.js is NOT modified — the stop button and thinking display reuse hooks that already exist in it.

**Tech Stack:** Python 3.14 / FastAPI / websockets / pytest (in `.venv`); vanilla-JS overlay modules (cron.js pattern).

**Spec:** `docs/superpowers/specs/2026-06-06-control-ui-borrowings-design.md`

**Cross-cutting rules:**
- All test commands run from `/Users/admin/openclaw-workspace` using `.venv/bin/python -m pytest`.
- **Do NOT restart the workspace LaunchAgent until the final smoke task** (each cold start is 100–190s on this host and stalls the codex brain). Unit tests and the standalone scripts (probe, sweep dry-run) don't need the workspace server.
- Gateway protocol facts cited in code comments were verified against `/Users/admin/openclaw` source (see spec).

---

### Task 1: Shared `gateway_call` helper (DRY foundation)

The one-shot "connect → auth → request → payload" dance is currently duplicated in `cron.py` (`_cron_call`) and `skills.py` (`fetch_skills`), and four new callers are coming (monitor, abort, session delete, skills toggle). Centralize it in `bridge.py`.

**Files:**
- Modify: `backend/bridge.py` (add `gateway_call` after `_request`, ~line 240)
- Modify: `backend/cron.py` (delete `_cron_call`, use `gateway_call`)
- Modify: `backend/skills.py` (use `gateway_call` in `fetch_skills`)

- [ ] **Step 1: Add `gateway_call` to `backend/bridge.py`** (right after the `_request` function):

```python
async def gateway_call(method: str, params: dict | None = None) -> dict:
    """One-shot gateway request on a fresh authed WS: connect, auth, call,
    return the response payload (raises RuntimeError on failure). The shared
    helper for every non-streaming adapter — cron, skills, monitor, session
    hygiene, abort."""
    url = config.gateway_ws_url()
    async with websockets.connect(url, max_size=None, open_timeout=30,
                                  ping_interval=None) as ws:
        await _wait_for_challenge(ws)
        hello = await _request(ws, "connect", _connect_params())
        if not hello.get("ok"):
            raise RuntimeError(f"gateway connect failed: {hello}")
        res = await _request(ws, method, params or {})
    if not res.get("ok"):
        raise RuntimeError(f"{method} failed: {res}")
    return res.get("payload") or {}
```

- [ ] **Step 2: Refactor `backend/cron.py` to use it.** Replace the imports and delete `_cron_call` (lines 10–32):

```python
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .bridge import gateway_call


router = APIRouter()
```

(The `import websockets` and `from . import config` lines go away too.) Then replace every `_cron_call(` call site with `gateway_call(` — there are three: in `list_cron`, `run_cron`, `enable_cron`/`disable_cron`.

- [ ] **Step 3: Refactor `backend/skills.py` `fetch_skills`.** Replace its body's WS block:

```python
async def fetch_skills() -> list[dict]:
    """Pull skills.status from the gateway, refresh the filePath cache, map them."""
    payload = await gateway_call("skills.status")
    raw = payload.get("skills") or []
    _by_name.clear()
    for s in raw:
        if s.get("name"):
            _by_name[s["name"]] = s
    return [_map_skill(s) for s in raw]
```

Update the imports: drop `import websockets` and `from . import config`; change the bridge import to `from .bridge import gateway_call`.

- [ ] **Step 4: Run the full suite to confirm nothing broke**

Run: `.venv/bin/python -m pytest backend/tests/ -q`
Expected: all pass (same count as before the change; the suite was green at 13de8a6).

- [ ] **Step 5: Commit**

```bash
git add backend/bridge.py backend/cron.py backend/skills.py
git commit -m "refactor: shared bridge.gateway_call for one-shot gateway requests"
```

---

### Task 2: Stop button — `chat.abort` backend

chat.js's Stop button ALREADY does two things (chat.js:2802-2816): aborts its fetch AND POSTs `/api/chat/stop/{session_id}`. That POST currently lands on the GET-only catch-all (405) and the gateway run keeps burning. Implement the endpoint. Protocol (verified): `chat.abort {sessionKey, runId?}` → `{runIds: []}`; the stream then sees a `chat` event with `state: "aborted"` (`src/gateway/protocol/schema/logs-chat.ts:54-60`).

**Files:**
- Modify: `backend/bridge.py` (`stream_turn` signature + `_relay_events` chat handler)
- Modify: `backend/app.py` (`_ACTIVE_RUNS`, endpoint, wiring in `chat_stream`)
- Create: `backend/tests/test_bridge_relay.py`

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_bridge_relay.py`:

```python
"""Unit tests for _relay_events' gateway-event → SSE mapping, driven by a fake
WS that replays canned frames (the real shapes, verified against the OpenClaw
source — see the control-ui-borrowings spec)."""
import asyncio
import json

from backend.bridge import _relay_events


class FakeWS:
    def __init__(self, frames):
        self._frames = [json.dumps(f) for f in frames]

    async def recv(self):
        if not self._frames:
            raise AssertionError("relay read past the last frame")
        return self._frames.pop(0)


def collect(frames, run_id="r1"):
    async def go():
        return [json.loads(c[5:]) for c in
                [x async for x in _relay_events(FakeWS(frames), run_id)]]
    return asyncio.run(go())


def test_delta_passthrough_and_lifecycle_end():
    out = collect([
        {"type": "event", "event": "chat",
         "payload": {"runId": "r1", "deltaText": "hi"}},
        {"type": "event", "event": "agent",
         "payload": {"runId": "r1", "stream": "lifecycle", "data": {"phase": "end"}}},
    ])
    assert out == [{"delta": "hi"}]


def test_aborted_state_maps_to_stopped_card():
    out = collect([
        {"type": "event", "event": "chat",
         "payload": {"runId": "r1", "state": "aborted"}},
    ])
    assert len(out) == 1
    assert out[0]["type"] == "tool_output"
    assert out[0]["exit_code"] == 0
    assert "stopped" in out[0]["output"]
```

- [ ] **Step 2: Run it to verify the new test fails**

Run: `.venv/bin/python -m pytest backend/tests/test_bridge_relay.py -v`
Expected: `test_delta_passthrough_and_lifecycle_end` PASSES (existing behavior); `test_aborted_state_maps_to_stopped_card` FAILS with "relay read past the last frame" (aborted isn't handled, the loop keeps reading).

- [ ] **Step 3: Handle `state: "aborted"` in `_relay_events`.** In `backend/bridge.py`, the chat-event branch currently starts:

```python
        if event == "chat":
            if payload.get("state") == "error":
```

Change it to:

```python
        if event == "chat":
            state = payload.get("state")
            if state == "aborted":
                # chat.abort landed (the Stop button) — end the turn cleanly,
                # not as an error.
                yield _sse({"type": "tool_output", "tool": "agent",
                            "tool_id": "abort", "output": "⏹ stopped by user",
                            "exit_code": 0})
                return
            if state == "error":
```

- [ ] **Step 4: Run the test again**

Run: `.venv/bin/python -m pytest backend/tests/test_bridge_relay.py -v`
Expected: both PASS.

- [ ] **Step 5: Expose the runId.** In `backend/bridge.py` change `stream_turn`'s signature:

```python
async def stream_turn(message: str, session_key: str | None = None,
                      model_ref: str | None = None,
                      run_info: dict | None = None):
```

and right after the existing `run_id = (ack.get("payload") or {}).get("runId")` line add:

```python
            if run_info is not None:
                run_info["sessionKey"] = session_key
                run_info["runId"] = run_id
```

- [ ] **Step 6: Wire `app.py`.** Below the imports (after the `app.include_router(...)` block) add:

```python
# Active gateway runs by sessionKey, so the Stop button can chat.abort the run
# server-side. chat.js already POSTs /api/chat/stop/<sid> on explicit Stop
# (abortCurrentRequest(true)) — until now that hit the GET-only catch-all and
# only the browser-side fetch died, while the codex run kept burning.
_ACTIVE_RUNS: dict[str, dict] = {}
```

In `chat_stream`, after `session_key = rec["sessionKey"] if rec else config.WEB_SESSION_KEY` add:

```python
    run_info: dict = {}  # bridge fills sessionKey/runId once chat.send acks
```

In `gen()`, replace the `async for chunk in bridge.stream_turn(...)` call with:

```python
            _ACTIVE_RUNS[session_key] = run_info
            async for chunk in bridge.stream_turn(brain_message, session_key=session_key,
                                                  model_ref=_model_ref(rec),
                                                  run_info=run_info):
```

and add `_ACTIVE_RUNS.pop(session_key, None)` as the FIRST line inside the `finally:` block.

Then add the endpoint (next to the other chat routes, after `stream_status`):

```python
@app.post("/api/chat/stop/{session_id}")
async def stop_chat(session_id: str):
    """The Stop button's server half: chat.abort the active gateway run.
    Verified shape: chat.abort {sessionKey, runId?} -> {runIds}; omitting
    runId aborts every run on the key (fine: per-chat keys, single user)."""
    session_key = sessions_store.session_key_for(session_id)
    params = {"sessionKey": session_key}
    run_id = (_ACTIVE_RUNS.get(session_key) or {}).get("runId")
    if run_id:
        params["runId"] = run_id
    try:
        payload = await bridge.gateway_call("chat.abort", params)
        return {"ok": True, "runIds": payload.get("runIds") or []}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": f"{exc!r}"})
```

- [ ] **Step 7: Full suite**

Run: `.venv/bin/python -m pytest backend/tests/ -q`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/bridge.py backend/app.py backend/tests/test_bridge_relay.py
git commit -m "feat: Stop button aborts the gateway run (chat.abort via /api/chat/stop)"
```

---

### Task 3: Persistent gateway monitor + `/api/gateway/status`

One long-lived, read-only WS that hears `shutdown` / `update-available` broadcasts (verified: `src/gateway/server-close.ts:161-164`) and keeps a state machine: `ok` → `restarting` (shutdown seen) → `down` (unannounced drop) → `ok` (reconnected). Health decoration is fetched lazily on a SEPARATE short-lived WS (the listen loop owns the monitor socket's `recv`; two readers on one websocket would race) and cached 60s.

**Files:**
- Create: `backend/monitor.py`
- Modify: `backend/app.py` (lifespan + endpoint)
- Create: `backend/tests/test_monitor.py`

- [ ] **Step 1: Write the failing tests** — create `backend/tests/test_monitor.py`:

```python
"""Unit tests for the gateway monitor's state machine (the pure handlers)."""
from backend import monitor


def setup_function(_fn):
    monitor._state.update(state="down", since=0.0,
                          updateAvailable=None, shutdownReason=None)


def test_shutdown_event_marks_restarting():
    monitor.handle_connected()
    monitor.handle_event("shutdown", {"reason": "restart"})
    assert monitor.current_state() == "restarting"
    assert monitor._state["shutdownReason"] == "restart"


def test_disconnect_after_shutdown_stays_restarting():
    monitor.handle_connected()
    monitor.handle_event("shutdown", {"reason": "restart"})
    monitor.handle_disconnect()
    assert monitor.current_state() == "restarting"


def test_unannounced_disconnect_is_down():
    monitor.handle_connected()
    monitor.handle_disconnect()
    assert monitor.current_state() == "down"


def test_reconnect_clears_restarting_and_reason():
    monitor.handle_event("shutdown", {"reason": "restart"})
    monitor.handle_connected()
    assert monitor.current_state() == "ok"
    assert monitor._state["shutdownReason"] is None


def test_update_available_is_cached():
    monitor.handle_event("update-available", {"version": "2026.6.2"})
    assert monitor._state["updateAvailable"]["version"] == "2026.6.2"
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest backend/tests/test_monitor.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'backend.monitor'`.

- [ ] **Step 3: Create `backend/monitor.py`:**

```python
"""Persistent gateway monitor: one long-lived, read-only WS that hears the
gateway's broadcast events (shutdown, update-available) the moment they fire,
and caches last-known state for the UI's status dot.

Separate from the per-turn bridge on purpose: the bridge opens a fresh WS per
chat turn, so while idle NOTHING is connected to hear a restart — on this host
(gateway cold-boots take 4-5 min) that made restarts indistinguishable from
disk-thrash stalls. This task never blocks or crashes the app: every failure
just degrades the reported state until reconnect.

Health decoration (agents, session count) is fetched lazily on its own
short-lived WS — the listen loop owns this socket's recv, and two concurrent
readers on one websockets connection raise — and cached for 60s.
"""
from __future__ import annotations

import asyncio
import json
import time

import websockets

from . import config
from .bridge import _connect_params, _request, _wait_for_challenge, gateway_call

# state: ok | restarting | down. "restarting" means we saw a shutdown event
# (the gateway is coming back); it converts to ok on reconnect. An unannounced
# drop is "down". Initial state is down until the first successful connect.
_state: dict = {"state": "down", "since": time.time(),
                "updateAvailable": None, "shutdownReason": None}
_health_cache: dict = {"at": 0.0, "agents": None, "sessionCount": None}
_HEALTH_TTL_S = 60.0
_BACKOFF_MAX_S = 30.0


def current_state() -> str:
    return _state["state"]


def _set_state(new: str) -> None:
    if _state["state"] != new:
        _state["state"] = new
        _state["since"] = time.time()


def handle_event(event: str, payload: dict) -> None:
    """Apply one gateway broadcast event to the state machine (no IO)."""
    if event == "shutdown":
        # {reason, restartExpectedMs?} — broadcast just before the gateway
        # closes (src/gateway/server-close.ts:161).
        _state["shutdownReason"] = (payload or {}).get("reason")
        _set_state("restarting")
    elif event == "update-available":
        # {version, ...} when a newer release exists; null/empty when clear.
        _state["updateAvailable"] = payload or None


def handle_disconnect() -> None:
    """The monitor WS dropped. A restart we were told about stays
    'restarting'; anything else is 'down'."""
    if _state["state"] != "restarting":
        _set_state("down")


def handle_connected() -> None:
    _state["shutdownReason"] = None
    _set_state("ok")


async def run() -> None:
    """The monitor task: connect, listen forever, reconnect with capped
    backoff. Started from the app's lifespan; cancelled on shutdown."""
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(config.gateway_ws_url(), max_size=None,
                                          open_timeout=30,
                                          ping_interval=None) as ws:
                await _wait_for_challenge(ws)
                hello = await _request(ws, "connect", _connect_params())
                if not hello.get("ok"):
                    raise RuntimeError(f"monitor connect failed: {hello}")
                handle_connected()
                backoff = 1.0
                while True:
                    frame = json.loads(await ws.recv())
                    if frame.get("type") == "event":
                        handle_event(frame.get("event") or "",
                                     frame.get("payload") or {})
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - any failure → reconnect loop
            pass
        handle_disconnect()
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, _BACKOFF_MAX_S)


async def status() -> dict:
    """The /api/gateway/status payload: cached state + (when up) lazy health."""
    out = {"state": _state["state"], "since": _state["since"],
           "shutdownReason": _state["shutdownReason"],
           "updateAvailable": _state["updateAvailable"],
           "agents": None, "sessionCount": None}
    if _state["state"] == "ok":
        out.update(await _health())
    return out


async def _health() -> dict:
    now = time.monotonic()
    if now - _health_cache["at"] < _HEALTH_TTL_S:
        return {"agents": _health_cache["agents"],
                "sessionCount": _health_cache["sessionCount"]}
    try:
        payload = await gateway_call("health")
        agents = [{"agentId": a.get("agentId"), "name": a.get("name")}
                  for a in (payload.get("agents") or [])]
        count = (payload.get("sessions") or {}).get("count")
    except Exception:  # noqa: BLE001 - health is best-effort decoration
        agents, count = None, None
    _health_cache.update(at=now, agents=agents, sessionCount=count)
    return {"agents": agents, "sessionCount": count}
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest backend/tests/test_monitor.py -v`
Expected: 5 PASS.

- [ ] **Step 5: Start the monitor from `app.py` and add the endpoint.** Add to the imports block: `from contextlib import asynccontextmanager` (top group) and `monitor` to the package import line:

```python
from . import bridge, config, draft_mode, monitor, sessions_store, websearch
```

Replace `app = FastAPI(title="OpenClaw Workspace")` with:

```python
@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # The persistent gateway monitor (status dot / restart awareness).
    task = asyncio.create_task(monitor.run())
    yield
    task.cancel()


app = FastAPI(title="OpenClaw Workspace", lifespan=_lifespan)
```

Add the endpoint right after the existing `/api/health` route:

```python
@app.get("/api/gateway/status")
async def gateway_status():
    """Last-known gateway state from the persistent monitor, for the UI's
    status dot (polled ~30s). state: ok | restarting | down."""
    return await monitor.status()
```

- [ ] **Step 6: Full suite + import sanity**

Run: `.venv/bin/python -m pytest backend/tests/ -q && .venv/bin/python -c "import backend.app"`
Expected: all pass; the import prints nothing and exits 0.

- [ ] **Step 7: Commit**

```bash
git add backend/monitor.py backend/app.py backend/tests/test_monitor.py
git commit -m "feat: persistent gateway monitor + /api/gateway/status (restart/health awareness)"
```

---

### Task 4: Mid-turn disconnect → explicit "gateway restarting" card

Today a gateway restart mid-turn surfaces as a generic `bridge error: ConnectionClosed...` card. Make it say what actually happened, informed by the monitor.

**Files:**
- Modify: `backend/bridge.py` (`stream_turn` except clause + helper)
- Modify: `backend/tests/test_bridge_relay.py` (helper test)

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_bridge_relay.py`:

```python
def test_disconnect_message_reflects_monitor_state():
    from backend.bridge import _disconnect_message
    assert "restarting" in _disconnect_message("restarting")
    assert "restarting" not in _disconnect_message("down")
    assert "may not have completed" in _disconnect_message("down")
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest backend/tests/test_bridge_relay.py::test_disconnect_message_reflects_monitor_state -v`
Expected: FAIL with ImportError (`_disconnect_message` doesn't exist).

- [ ] **Step 3: Implement.** In `backend/bridge.py` add near `_error_text`:

```python
def _disconnect_message(monitor_state: str) -> str:
    """A human explanation for a WS that died mid-turn, using what the
    persistent monitor knows. On this host the gateway restarts (launchctl
    kickstart, updates) and cold-boots for minutes — say so instead of a
    generic error."""
    if monitor_state == "restarting":
        return ("🧠 the gateway is restarting — this message may not have "
                "completed; retry once the status dot is green")
    return ("🧠 lost the gateway connection mid-turn — this message may not "
            "have completed")
```

And in `stream_turn`, insert a specific except BEFORE the generic one:

```python
    except websockets.ConnectionClosed:
        from . import monitor  # local import: monitor imports bridge helpers
        yield _sse({"type": "tool_output", "tool": "bridge",
                    "output": _disconnect_message(monitor.current_state()),
                    "exit_code": 1})
    except Exception as exc:  # noqa: BLE001 - surface any failure into the UI
```

- [ ] **Step 4: Run tests**

Run: `.venv/bin/python -m pytest backend/tests/ -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/bridge.py backend/tests/test_bridge_relay.py
git commit -m "feat: explicit restart-aware card when the gateway drops mid-turn"
```

---

### Task 5: Status dot + banner overlay (frontend)

Self-contained overlay module, exactly the cron.js pattern: IIFE, injects `#rail-gateway` into `#icon-rail` before `#rail-theme`, MutationObserver re-injection, polls `/api/gateway/status` every 30s + on window focus.

**Files:**
- Create: `frontend-overrides/js/gateway-status.js`
- Modify: `frontend-overrides/workspace.css` (append styles)
- Modify: `scripts/sync-frontend.sh` (injection block)

- [ ] **Step 1: Create `frontend-overrides/js/gateway-status.js`:**

```javascript
/* OpenClaw Workspace — gateway status dot + banner (overlay add-on).
 *
 * Polls /api/gateway/status (backed by the backend's persistent monitor WS)
 * and shows: a colored dot in the icon rail (green ok / amber restarting /
 * red down) and a dismissible banner when the brain is restarting, down, or
 * has an update available. Self-contained like cron.js: builds its own DOM,
 * survives SPA re-renders via MutationObserver, loaded by a <script> the
 * sync script injects.
 */
(function () {
  'use strict';
  const API = window.location.origin;
  const POLL_MS = 30000;
  const $ = (sel, root) => (root || document).querySelector(sel);
  let _last = null;

  function injectDot() {
    const rail = $('#icon-rail');
    if (!rail || $('#rail-gateway')) return;
    const btn = document.createElement('button');
    btn.className = 'icon-rail-btn';
    btn.id = 'rail-gateway';
    btn.title = 'Gateway status';
    btn.innerHTML = '<span class="gw-dot" id="gw-dot"></span>';
    btn.addEventListener('click', refresh);
    const theme = $('#rail-theme', rail);
    if (theme) rail.insertBefore(btn, theme); else rail.appendChild(btn);
  }

  function ensureBanner() {
    let b = $('#gw-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'gw-banner';
      b.innerHTML = '<span id="gw-banner-text"></span>' +
        '<button id="gw-banner-x" title="Dismiss">✕</button>';
      document.body.prepend(b);
      $('#gw-banner-x', b).addEventListener('click', () => {
        b.dataset.dismissed = '1';
        b.style.display = 'none';
      });
    }
    return b;
  }

  function render(s) {
    const dot = $('#gw-dot');
    if (dot) dot.dataset.state = s.state;
    const btn = $('#rail-gateway');
    if (btn) {
      const bits = [`gateway: ${s.state}`];
      if (s.sessionCount != null) bits.push(`${s.sessionCount} sessions`);
      if (s.updateAvailable && s.updateAvailable.version) {
        bits.push(`update ${s.updateAvailable.version} available`);
      }
      btn.title = bits.join(' · ');
    }
    const banner = ensureBanner();
    const text = $('#gw-banner-text');
    let msg = '';
    if (s.state === 'restarting') {
      msg = '🧠 The brain is restarting — replies will resume shortly.';
    } else if (s.state === 'down') {
      msg = '🧠 The brain is unreachable — chat will fail until the gateway is back.';
    } else if (s.updateAvailable && s.updateAvailable.version) {
      msg = `OpenClaw update available: ${s.updateAvailable.version}`;
    }
    if (text) text.textContent = msg;
    // A state CHANGE re-arms a dismissed banner (new news beats old dismissal).
    if (_last && _last.state !== s.state) banner.dataset.dismissed = '';
    banner.style.display = (msg && banner.dataset.dismissed !== '1') ? 'flex' : 'none';
    _last = s;
  }

  async function refresh() {
    try {
      const res = await fetch(`${API}/api/gateway/status`);
      if (!res.ok) return;        // workspace hiccup — keep last known state
      render(await res.json());
    } catch (_) { /* network blip — keep last known state */ }
  }

  function init() {
    injectDot();
    const rail = document.getElementById('icon-rail');
    if (rail && window.MutationObserver) {
      new MutationObserver(() => {
        if (!document.getElementById('rail-gateway')) injectDot();
      }).observe(rail, { childList: true });
    }
    refresh();
    setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
```

- [ ] **Step 2: Append styles to `frontend-overrides/workspace.css`:**

```css
/* --- Gateway status dot (rail) + banner ------------------------------------ */
.gw-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  background: #8e8e93; vertical-align: middle; }
.gw-dot[data-state="ok"] { background: #34c759; }
.gw-dot[data-state="restarting"] { background: #ff9f0a; animation: gw-pulse 1.2s infinite; }
.gw-dot[data-state="down"] { background: #ff3b30; }
@keyframes gw-pulse { 50% { opacity: 0.35; } }
#gw-banner { display: none; position: sticky; top: 0; z-index: 300;
  align-items: center; gap: 10px; padding: 7px 14px; font-size: 13px;
  background: rgba(255, 159, 10, 0.14); color: inherit;
  border-bottom: 1px solid rgba(255, 159, 10, 0.45); }
#gw-banner button { margin-left: auto; background: none; border: none;
  color: inherit; cursor: pointer; font-size: 13px; opacity: 0.7; }
#gw-banner button:hover { opacity: 1; }
```

- [ ] **Step 3: Add the injection block to `scripts/sync-frontend.sh`** — right after the inbox.js block (after line 77, inside the same `if [[ -d "$OVERRIDES" ]]` body):

```bash
  # Inject the gateway-status add-on once, just before </body> (idempotent).
  SCRIPT_GW='<script src="/static/js/gateway-status.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/gateway-status.js" ]] \
     && ! grep -qF "js/gateway-status.js" "$INDEX"; then
    awk -v s="  $SCRIPT_GW" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected gateway-status.js <script> into index.html"
  fi
```

- [ ] **Step 4: Run the sync and verify the injection**

Run: `./scripts/sync-frontend.sh && grep -c "gateway-status.js" frontend/index.html && ls frontend/js/gateway-status.js`
Expected: sync output includes `injected gateway-status.js <script> into index.html`; grep prints `1`; the file exists. Run the sync a second time and confirm grep still prints `1` (idempotent).

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/gateway-status.js frontend-overrides/workspace.css scripts/sync-frontend.sh
git commit -m "feat: gateway status dot + restart banner overlay"
```

---

### Task 6: Session hygiene — gateway delete on chat delete, `sessions.patch` for model pin

Verified shapes: `sessions.delete {key, deleteTranscript?}` → `{ok, key, deleted, archived[]}` (deleteTranscript defaults true; we pass it explicitly) and `sessions.patch {key, model}` → `{ok, ..., resolved}` (`src/gateway/protocol/schema/sessions.ts:131-191`). `sessions.patch` may reject a key with no entry yet (fresh chat before first turn) — fall back to the `sessions.create` upsert.

**Files:**
- Modify: `backend/app.py` (`delete_session`)
- Modify: `backend/bridge.py` (`stream_turn` model-pin block)

- [ ] **Step 1: Gateway-side delete in `app.py`.** Replace the `delete_session` route with:

```python
async def _delete_gateway_session(session_key: str) -> None:
    """Best-effort gateway-side delete (transcript included) so removing a
    chat here doesn't leave its thread accumulating in the brain's session
    store — real weight on this 8GB box. Verified: sessions.delete
    {key, deleteTranscript} (deleteTranscript defaults true anyway)."""
    try:
        await bridge.gateway_call("sessions.delete",
                                  {"key": session_key, "deleteTranscript": True})
    except Exception:  # noqa: BLE001 - local delete already succeeded
        pass


@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    rec = sessions_store.get(session_id)
    ok = sessions_store.delete(session_id)
    if ok and rec and rec.get("sessionKey"):
        asyncio.create_task(_delete_gateway_session(rec["sessionKey"]))
    return {"ok": ok}
```

- [ ] **Step 2: Swap the model pin to `sessions.patch`.** In `backend/bridge.py` `stream_turn`, replace the model-pin block (the `if model_ref:` block calling `sessions.create`) with:

```python
            # 1b. Pin this session's model (best-effort; never block the turn).
            # sessions.patch is the documented mutation for modelOverride; a
            # fresh chat may have no session entry yet, so fall back to the
            # sessions.create upsert when patch rejects the key.
            if model_ref:
                try:
                    res = await _request(ws, "sessions.patch",
                                         {"key": session_key, "model": model_ref})
                    if not res.get("ok"):
                        await _request(ws, "sessions.create",
                                       {"key": session_key, "model": model_ref})
                except Exception:  # noqa: BLE001 - fall back to the default model
                    pass
```

- [ ] **Step 3: Full suite**

Run: `.venv/bin/python -m pytest backend/tests/ -q`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add backend/app.py backend/bridge.py
git commit -m "feat: chat delete hard-deletes the gateway session; model pin via sessions.patch"
```

---

### Task 7: Orphan-session sweep script

Maintenance script (not UI): list gateway sessions, keep web threads that are referenced by anything in `.data/*.json`, protected, or recently active (<24h — a running research thread might not be persisted), delete the rest WITH transcripts. Dry-run by default. Note `agent:main:inbox-triage` is not web-prefixed, so the prefix filter never touches it.

**Files:**
- Create: `scripts/purge_orphan_sessions.py`
- Create: `backend/tests/test_purge_orphans.py`

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_purge_orphans.py`:

```python
"""Unit tests for the orphan-session sweep's pure filter (the script isn't a
package module, so load it by path)."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "purge_orphan_sessions",
    Path(__file__).resolve().parents[2] / "scripts" / "purge_orphan_sessions.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
find_orphans = _mod.find_orphans

NOW = 1_800_000_000_000
OLD = NOW - 2 * 86_400_000  # 2 days ago — past the recency guard


def _sess(key, updated=OLD):
    return {"key": key, "updatedAt": updated}


def test_keeps_referenced_protected_recent_and_non_web():
    sessions = [
        _sess("agent:main:web-aaa"),        # referenced in .data → keep
        _sess("agent:main:web-bbb"),        # orphan → delete
        _sess("agent:main:web-titler"),     # protected → keep
        _sess("agent:main:main"),           # not a web thread → keep
        _sess("agent:main:web-ccc", NOW),   # active <24h → keep (research guard)
    ]
    blob = '{"sessionKey": "agent:main:web-aaa"}'
    out = find_orphans(sessions, blob, "agent:main:web",
                       {"agent:main:web", "agent:main:web-titler"}, NOW)
    assert out == ["agent:main:web-bbb"]


def test_research_threads_match_the_web_prefix():
    out = find_orphans([_sess("agent:main:web-research-xyz")],
                       "", "agent:main:web", set(), NOW)
    assert out == ["agent:main:web-research-xyz"]


def test_bare_web_key_is_not_a_per_chat_thread():
    # The shared key has no "-" suffix; the prefix filter must skip it even
    # when it's not in the protected set.
    out = find_orphans([_sess("agent:main:web")], "", "agent:main:web", set(), NOW)
    assert out == []
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest backend/tests/test_purge_orphans.py -v`
Expected: FAIL — the script file doesn't exist yet (FileNotFoundError from spec loading).

- [ ] **Step 3: Create `scripts/purge_orphan_sessions.py`:**

```python
#!/usr/bin/env python3
"""Delete gateway web-* sessions that no longer have a local chat record.

Chats deleted before the workspace learned to hard-delete (plus finished
research/utility threads) leave transcripts accumulating in the gateway's
session store — real weight on this 8GB box. This sweep lists the gateway's
sessions and deletes (WITH transcript) every `agent:main:web-*` thread that:
  - is not referenced anywhere in .data/*.json (sessions, research jobs, ...),
  - is not a protected utility key, and
  - has been idle for >24h (a live research thread may not be persisted yet).

Dry-run by default:
    .venv/bin/python scripts/purge_orphan_sessions.py
    .venv/bin/python scripts/purge_orphan_sessions.py --apply
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import config               # noqa: E402
from backend.bridge import gateway_call  # noqa: E402

# Never delete these even when unreferenced: the shared web key and the
# utility threads the backend uses on demand.
PROTECTED = {
    config.WEB_SESSION_KEY,
    f"{config.WEB_SESSION_PREFIX}-titler",
    f"{config.WEB_SESSION_PREFIX}-memex",
}

_MIN_AGE_MS = 24 * 3600 * 1000  # don't touch threads active in the last day


def find_orphans(sessions: list, referenced_blob: str, prefix: str,
                 protected: set, now_ms: int,
                 min_age_ms: int = _MIN_AGE_MS) -> list:
    """Pure filter: per-chat web threads (`<prefix>-...`) that nothing
    references, aren't protected, and have been idle past the age guard."""
    orphans = []
    for s in sessions:
        key = (s.get("key") or "") if isinstance(s, dict) else ""
        if not key.startswith(prefix + "-"):
            continue  # not a per-chat web thread (also skips the bare key)
        if key in protected or key in referenced_blob:
            continue
        if (s.get("updatedAt") or 0) > now_ms - min_age_ms:
            continue  # recently active — could be a running research thread
        orphans.append(key)
    return orphans


def _referenced_blob() -> str:
    """Everything in .data/*.json as one searchable string — any file that
    mentions a session key (sessions.json, research stores, ...) keeps it."""
    parts = []
    for f in sorted(config.DATA_DIR.glob("*.json")):
        try:
            parts.append(f.read_text())
        except OSError:
            pass
    return "\n".join(parts)


async def main(apply: bool) -> None:
    payload = await gateway_call("sessions.list",
                                 {"limit": 1000, "includeGlobal": True,
                                  "includeUnknown": True})
    sessions = payload.get("sessions") or []
    orphans = find_orphans(sessions, _referenced_blob(),
                           config.WEB_SESSION_PREFIX, PROTECTED,
                           int(time.time() * 1000))
    print(f"{len(sessions)} gateway sessions, {len(orphans)} orphaned web threads")
    for key in orphans:
        if apply:
            res = await gateway_call("sessions.delete",
                                     {"key": key, "deleteTranscript": True})
            print(f"deleted  {key}  -> {res}")
        else:
            print(f"would delete  {key}")
    if orphans and not apply:
        print("\ndry-run only — re-run with --apply to delete")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="actually delete (default: dry-run)")
    asyncio.run(main(ap.parse_args().apply))
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest backend/tests/test_purge_orphans.py -v`
Expected: 3 PASS.

- [ ] **Step 5: Live dry-run** (gateway only — no workspace restart needed):

Run: `.venv/bin/python scripts/purge_orphan_sessions.py`
Expected: a count line plus `would delete agent:main:web-...` lines (or "0 orphaned"). Sanity-check the list: every key should look like an old per-chat/research thread; `web-titler`, `web-memex`, and the bare `agent:main:web` must NOT appear. **Show the list to the user before anyone runs `--apply`.**

- [ ] **Step 6: Commit**

```bash
git add scripts/purge_orphan_sessions.py backend/tests/test_purge_orphans.py
git commit -m "feat: orphaned gateway web-session sweep (dry-run by default)"
```

---

### Task 8: Thinking display — live probe, then bridge mapping

The SPA already renders thinking: any `{"delta": text, "thinking": true}` SSE frame is wrapped in `<think>` tags (chat.js:1370-1376) and shown as a collapsed "View thinking process" section with a timer (markdown.js:275). The bridge just needs to map `kind: "analysis"` item events (verified kind name: `src/infra/agent-events.ts:21-27`) into such frames. The one unknown is whether the reasoning text arrives incremental (`delta`-style) or cumulative (`text`/`summary`) — the helper below handles BOTH via a per-item cursor, and the probe confirms which fields actually carry text.

**Files:**
- Create: `scripts/probe_thinking.py`
- Modify: `backend/bridge.py` (`_analysis_delta` helper + relay branch)
- Modify: `backend/tests/test_bridge_relay.py` (mapping tests)

- [ ] **Step 1: Create the probe** — `scripts/probe_thinking.py`:

```python
#!/usr/bin/env python3
"""One-turn probe: dump the raw non-tool `agent` item events for a live turn,
to see exactly which fields carry gpt-5.5's reasoning text (incremental delta
vs cumulative text/summary). Run while the gateway is healthy; costs one cheap
codex turn on a scratch session.

    .venv/bin/python scripts/probe_thinking.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import websockets                                      # noqa: E402
from backend import config                             # noqa: E402
from backend.bridge import (_await_response, _connect_params,  # noqa: E402
                            _request, _wait_for_challenge)

SESSION = f"{config.WEB_SESSION_PREFIX}-probe"
PROMPT = "What is 17 * 23? Think it through step by step before answering."


async def main() -> None:
    async with websockets.connect(config.gateway_ws_url(), max_size=None,
                                  open_timeout=30, ping_interval=None) as ws:
        await _wait_for_challenge(ws)
        hello = await _request(ws, "connect", _connect_params())
        assert hello.get("ok"), hello
        send_id = uuid.uuid4().hex
        await ws.send(json.dumps({
            "type": "req", "id": send_id, "method": "chat.send",
            "params": {"sessionKey": SESSION, "message": PROMPT,
                       "deliver": False, "idempotencyKey": uuid.uuid4().hex}}))
        ack = await _await_response(ws, send_id)
        assert ack.get("ok"), ack
        run_id = (ack.get("payload") or {}).get("runId")
        while True:
            frame = json.loads(await ws.recv())
            if frame.get("type") != "event":
                continue
            payload = frame.get("payload") or {}
            if run_id and payload.get("runId") not in (None, run_id):
                continue
            if frame.get("event") != "agent":
                continue
            data = payload.get("data") or {}
            if (payload.get("stream") == "item"
                    and data.get("kind") not in ("command", "tool")):
                print(json.dumps(frame, indent=2))
            if (payload.get("stream") == "lifecycle"
                    and data.get("phase") in ("end", "error")):
                return


asyncio.run(main())
```

- [ ] **Step 2: Run the probe live**

Run: `.venv/bin/python scripts/probe_thinking.py`
Expected: JSON frames with `kind: "analysis"` showing where the reasoning text lives. Record the answer (incremental `delta` field vs cumulative `text`/`summary`, and the phase values seen). If NO analysis events appear: thinking may be disabled for ad-hoc sessions or the model didn't reason on this prompt — try a harder prompt once; if still nothing, the bridge mapping below is still safe to land (it simply never fires) — note the finding and continue.

- [ ] **Step 3: Write the failing mapping tests** — append to `backend/tests/test_bridge_relay.py`:

```python
def test_analysis_items_map_to_thinking_deltas_with_cumulative_diff():
    def item(phase, **fields):
        return {"type": "event", "event": "agent",
                "payload": {"runId": "r1", "stream": "item",
                            "data": {"itemId": "a1", "kind": "analysis",
                                     "phase": phase, **fields}}}
    out = collect([
        item("start"),
        item("update", text="Let me think"),
        item("update", text="Let me think harder"),  # cumulative → diff
        {"type": "event", "event": "chat",
         "payload": {"runId": "r1", "deltaText": "391"}},
        {"type": "event", "event": "agent",
         "payload": {"runId": "r1", "stream": "lifecycle",
                     "data": {"phase": "end"}}},
    ])
    thinking = [c for c in out if c.get("thinking")]
    assert [c["delta"] for c in thinking] == ["Let me think", " harder"]
    assert out[-1] == {"delta": "391"}


def test_analysis_delta_field_passes_through_incremental():
    from backend.bridge import _analysis_delta
    seen = {}
    assert _analysis_delta({"itemId": "a1", "delta": "abc"}, seen) == "abc"
    assert _analysis_delta({"itemId": "a1", "delta": "def"}, seen) == "def"


def test_analysis_delta_ignores_empty_and_repeat():
    from backend.bridge import _analysis_delta
    seen = {}
    assert _analysis_delta({"itemId": "a1", "text": "abc"}, seen) == "abc"
    assert _analysis_delta({"itemId": "a1", "text": "abc"}, seen) == ""
    assert _analysis_delta({"itemId": "a1"}, seen) == ""
```

- [ ] **Step 4: Run to verify failure**

Run: `.venv/bin/python -m pytest backend/tests/test_bridge_relay.py -v`
Expected: the three new tests FAIL (ImportError / frames unconsumed); earlier ones still pass.

- [ ] **Step 5: Implement in `backend/bridge.py`.** Add the helper near `_error_text`:

```python
def _analysis_delta(data: dict, seen: dict) -> str:
    """The NEW reasoning text in one `analysis` item event. Handles both an
    incremental `delta` field and cumulative `text`/`summary` snapshots — the
    per-item cursor in `seen` (itemId -> chars already emitted) diffs
    cumulative payloads down to the fresh suffix. Update this comment with the
    shape the probe (scripts/probe_thinking.py) observed live."""
    if isinstance(data.get("delta"), str) and data["delta"]:
        return data["delta"]
    text = data.get("text") or data.get("summary") or ""
    if not isinstance(text, str) or not text:
        return ""
    item_id = data.get("itemId") or ""
    cursor = seen.get(item_id, 0)
    if len(text) <= cursor:
        return ""
    seen[item_id] = len(text)
    return text[cursor:]
```

Then in `_relay_events`: initialize `analysis_seen: dict = {}` next to `emitted_len = 0`, update the `_TOOL_ITEM_KINDS` comment (analysis is now mapped, `preamble` still skipped), and add this branch ABOVE the existing `if stream == "item" and data.get("kind") in _TOOL_ITEM_KINDS:` check:

```python
        if stream == "item" and data.get("kind") == "analysis":
            # Reasoning. The SPA already has a collapsed "View thinking
            # process" UI driven by {"delta": …, "thinking": true} frames
            # (chat.js wraps them in <think> tags) — reuse it, no new frame
            # types needed.
            text = _analysis_delta(data, analysis_seen)
            if text:
                if tool_since_text:
                    yield _sse({"type": "agent_step"})  # open a fresh bubble
                    tool_since_text = False
                yield _sse({"delta": text, "thinking": True})
            continue
```

- [ ] **Step 6: Run the tests**

Run: `.venv/bin/python -m pytest backend/tests/ -q`
Expected: all pass. If the probe showed a DIFFERENT field carrying the text (e.g. only `title`), extend `_analysis_delta`'s fallback chain to include it and update the docstring comment with the observed shape.

- [ ] **Step 7: Commit**

```bash
git add backend/bridge.py backend/tests/test_bridge_relay.py scripts/probe_thinking.py
git commit -m "feat: stream gpt-5.5 reasoning into the SPA's thinking UI"
```

---

### Task 9: Cron run history — backend

Verified: `cron.runs {scope:"job", id, limit (1-200)}` → entries `{ts, jobId, status, error?, summary?, durationMs?, runAtMs?, delivered?, ...}` (`src/gateway/protocol/schema/cron.ts:326-378`). The response's container key wasn't pinned down — tolerate the obvious candidates.

**Files:**
- Modify: `backend/cron.py` (mappers + endpoint)
- Create: `backend/tests/test_cron_runs.py`

- [ ] **Step 1: Write the failing tests** — create `backend/tests/test_cron_runs.py`:

```python
"""Unit tests for the cron run-history mappers."""
from backend.cron import _map_run, _runs_list


def test_map_run_prefers_run_at_and_truncates_long_text():
    out = _map_run({"ts": 1, "runAtMs": 2, "status": "error",
                    "durationMs": 1234, "summary": "s" * 600,
                    "error": "boom", "delivered": False})
    assert out["ts"] == 2
    assert out["status"] == "error"
    assert out["durationMs"] == 1234
    assert len(out["summary"]) == 500
    assert out["error"] == "boom"
    assert out["delivered"] is False


def test_map_run_defaults():
    out = _map_run({"ts": 7})
    assert out["ts"] == 7
    assert out["status"] == "ok"
    assert out["summary"] == "" and out["error"] == ""


def test_runs_list_tolerates_container_shapes():
    assert _runs_list({"entries": [{"a": 1}]}) == [{"a": 1}]
    assert _runs_list({"runs": [1]}) == [1]
    assert _runs_list({"logs": [2]}) == [2]
    assert _runs_list([3]) == [3]
    assert _runs_list({"nope": 4}) == []
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest backend/tests/test_cron_runs.py -v`
Expected: FAIL with ImportError (`_map_run` doesn't exist).

- [ ] **Step 3: Implement in `backend/cron.py`** (after `_map_job`):

```python
def _map_run(r: dict) -> dict:
    """One cron.runs entry → the UI's history-row shape. Verified entry shape:
    {ts, jobId, status: ok|error|skipped, error?, summary?, durationMs?,
    runAtMs?, delivered?, ...} (gateway protocol/schema/cron.ts)."""
    return {
        "ts": r.get("runAtMs") or r.get("ts"),
        "status": r.get("status") or "ok",
        "durationMs": r.get("durationMs"),
        "summary": (r.get("summary") or "")[:500],
        "error": (r.get("error") or "")[:500],
        "delivered": r.get("delivered"),
    }


def _runs_list(payload) -> list:
    """cron.runs' container key isn't pinned down across gateway versions —
    accept the obvious candidates and a bare list."""
    if isinstance(payload, list):
        return payload
    for key in ("entries", "runs", "logs", "items"):
        val = payload.get(key)
        if isinstance(val, list):
            return val
    return []
```

and the route (after `list_cron`, before the `/{job_id}/run` route so paths stay grouped — FastAPI matches these literal segments fine in any order):

```python
@router.get("/api/cron/{job_id}/runs")
async def cron_runs(job_id: str, limit: int = 50):
    try:
        data = await gateway_call("cron.runs", {
            "scope": "job", "id": job_id,
            "limit": max(1, min(int(limit), 200)),
        })
        return {"runs": [_map_run(r) for r in _runs_list(data)]}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"runs": [], "error": f"{exc!r}"})
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest backend/tests/ -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/cron.py backend/tests/test_cron_runs.py
git commit -m "feat: per-job cron run history endpoint (cron.runs)"
```

---

### Task 10: Cron run history — UI

Add a History button per job row that toggles an inline run list. All in the existing self-contained overlay.

**Files:**
- Modify: `frontend-overrides/js/cron.js`
- Modify: `frontend-overrides/workspace.css` (append styles)

- [ ] **Step 1: Add the button + panel to the row template.** In `render()` (cron.js:78-102), change the actions block from:

```javascript
        `  <div class="cron-job-actions">` +
        `    <button class="cron-btn cron-run" title="Run now">Run</button>` +
```

to:

```javascript
        `  <div class="cron-job-actions">` +
        `    <button class="cron-btn cron-history" title="Recent runs">⟲</button>` +
        `    <button class="cron-btn cron-run" title="Run now">Run</button>` +
```

and add the (hidden) panel inside `cron-job-main`, right after the meta line:

```javascript
        (meta ? `    <div class="cron-job-meta">${meta}</div>` : '') +
        `    <div class="cron-job-runs" hidden></div>` +
```

Then wire it in the `forEach` at cron.js:103-107 by adding:

```javascript
      row.querySelector('.cron-history').addEventListener('click', () => toggleRuns(id, row));
```

- [ ] **Step 2: Add the loader** (after `toggleJob`, before `injectRailButton`):

```javascript
  function fmtDur(ms) {
    if (ms == null) return '';
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

  async function toggleRuns(id, row) {
    const panel = row.querySelector('.cron-job-runs');
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = '<div class="cron-empty">Loading…</div>';
    try {
      const res = await fetch(`${API}/api/cron/${encodeURIComponent(id)}/runs?limit=20`);
      const data = await res.json();
      const runs = data.runs || [];
      if (!runs.length) {
        panel.innerHTML = '<div class="cron-empty">No recorded runs.</div>';
        return;
      }
      panel.innerHTML = runs.map((r) => {
        const ok = r.status === 'ok';
        const skip = r.status === 'skipped';
        const icon = ok ? '✓' : (skip ? '–' : '✗');
        const cls = ok ? 'ok' : (skip ? 'skip' : 'err');
        const line = r.error || r.summary || '';
        return (
          `<div class="cron-run-row cron-run-${cls}">` +
          `<span class="cron-run-icon">${icon}</span>` +
          `<span class="cron-run-time">${esc(fmtTime(r.ts))}</span>` +
          `<span class="cron-run-dur">${esc(fmtDur(r.durationMs))}</span>` +
          (line ? `<span class="cron-run-line" title="${esc(line)}">${esc(line)}</span>` : '') +
          `</div>`
        );
      }).join('');
    } catch (e) {
      panel.innerHTML = `<div class="cron-empty">Failed: ${esc(e && e.message)}</div>`;
    }
  }
```

- [ ] **Step 3: Append styles to `frontend-overrides/workspace.css`:**

```css
/* --- Cron run history ------------------------------------------------------- */
.cron-job-runs { margin-top: 6px; padding-top: 4px;
  border-top: 1px solid rgba(128, 128, 128, 0.25);
  display: flex; flex-direction: column; gap: 2px; }
.cron-run-row { display: flex; gap: 8px; align-items: baseline;
  font-size: 11.5px; opacity: 0.85; min-width: 0; }
.cron-run-icon { width: 12px; text-align: center; flex: none; }
.cron-run-ok .cron-run-icon { color: #34c759; }
.cron-run-err .cron-run-icon { color: #ff3b30; }
.cron-run-skip .cron-run-icon { opacity: 0.5; }
.cron-run-time, .cron-run-dur { white-space: nowrap; flex: none; }
.cron-run-dur { opacity: 0.7; }
.cron-run-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 4: Apply + sanity-check**

Run: `./scripts/sync-frontend.sh && grep -c "cron-history" frontend/js/cron.js`
Expected: sync succeeds; grep prints `2` (template + listener).

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/cron.js frontend-overrides/workspace.css
git commit -m "feat: per-job run history in the cron modal"
```

---

### Task 11: Skills toggles — backend

Verified: `skills.update {skillKey, enabled}` → `{ok, skillKey, config}` (`src/gateway/server-methods/skills.ts:240-346`). `skills.status` entries carry `disabled` and `skillKey`; the existing `_by_name` cache resolves display name → entry.

**Files:**
- Modify: `backend/skills.py` (`_map_skill` + endpoint)
- Create: `backend/tests/test_skills_map.py`

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_skills_map.py`:

```python
"""Unit tests for the skills mapper."""
from backend.skills import _map_skill


def test_map_skill_exposes_enabled():
    assert _map_skill({"name": "a"})["enabled"] is True
    assert _map_skill({"name": "a", "disabled": True})["enabled"] is False
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest backend/tests/test_skills_map.py -v`
Expected: FAIL with KeyError `'enabled'`.

- [ ] **Step 3: Implement.** In `_map_skill`'s returned dict add (after the `"emoji"` line):

```python
        "enabled": not s.get("disabled"),
```

Then add the endpoint (after `skill_markdown`, before `delete_skill`):

```python
@router.post("/api/skills/{name}/enabled")
async def set_skill_enabled(name: str, body: dict = Body(default=None)):
    """Enable/disable one skill via the gateway. Verified: skills.update
    {skillKey, enabled} -> {ok, skillKey, config}. The overlay toggle posts
    {"enabled": bool}; `name` is the display name (resolved to skillKey via
    the cache) or already a skillKey."""
    enabled = bool((body or {}).get("enabled", True))
    entry = _by_name.get(name)
    if entry is None:
        try:
            await fetch_skills()  # refresh the name -> entry cache
        except Exception:  # noqa: BLE001
            pass
        entry = _by_name.get(name)
    skill_key = (entry or {}).get("skillKey") or name
    try:
        payload = await gateway_call("skills.update",
                                     {"skillKey": skill_key, "enabled": enabled})
        return {"ok": True, "skillKey": skill_key, "enabled": enabled,
                "config": payload.get("config")}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": f"{exc!r}"})
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest backend/tests/ -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/skills.py backend/tests/test_skills_map.py
git commit -m "feat: skill enable/disable endpoint (skills.update)"
```

---

### Task 12: Skills toggles — overlay UI

skills.js is NOT overridden (large, changes upstream) — so don't fork it. A separate overlay decorates each rendered `.skill-card` with a toggle, exactly the cron.js pattern. State comes from `/api/skills` (the new `enabled` field).

**Files:**
- Create: `frontend-overrides/js/skills-toggle.js`
- Modify: `frontend-overrides/workspace.css` (append styles)
- Modify: `scripts/sync-frontend.sh` (injection block)

- [ ] **Step 1: Create `frontend-overrides/js/skills-toggle.js`:**

```javascript
/* OpenClaw Workspace — skill enable/disable toggles (overlay add-on).
 *
 * skills.js renders the panel read-only and is NOT overridden (large, changes
 * upstream). This module decorates each rendered .skill-card with a toggle
 * switch wired to the backend's POST /api/skills/<name>/enabled (gateway
 * skills.update). Enabled-state comes from /api/skills' `enabled` field.
 * Self-contained like cron.js; loaded via a <script> the sync injects.
 */
(function () {
  'use strict';
  const API = window.location.origin;
  let _enabledByName = null;

  async function loadStates() {
    try {
      const res = await fetch(`${API}/api/skills`);
      const data = await res.json();
      _enabledByName = {};
      (data.skills || []).forEach((s) => {
        _enabledByName[s.name] = s.enabled !== false;
      });
    } catch (_) { _enabledByName = null; }
  }

  function decorate() {
    if (!_enabledByName) return;
    document.querySelectorAll('.skill-card').forEach((card) => {
      if (card.querySelector('.skill-enable-toggle')) return;
      const name = card.dataset.skillName;
      if (!name || !(name in _enabledByName)) return;
      const right = card.querySelector('.skill-card-right');
      if (!right) return;
      const on = _enabledByName[name];
      const btn = document.createElement('button');
      btn.className = 'skill-enable-toggle' + (on ? ' on' : '');
      btn.title = on ? 'Skill enabled — click to disable'
                     : 'Skill disabled — click to enable';
      btn.setAttribute('role', 'switch');
      btn.setAttribute('aria-checked', String(on));
      btn.innerHTML = '<span></span>';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();   // don't expand/collapse the card
        toggle(name, btn);
      });
      right.prepend(btn);
    });
  }

  async function toggle(name, btn) {
    const next = !btn.classList.contains('on');
    btn.classList.toggle('on', next);  // optimistic
    btn.setAttribute('aria-checked', String(next));
    try {
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      _enabledByName[name] = next;
      btn.title = next ? 'Skill enabled — click to disable'
                       : 'Skill disabled — click to enable';
    } catch (e) {
      btn.classList.toggle('on', !next);  // revert
      btn.setAttribute('aria-checked', String(!next));
      btn.title = `Toggle failed: ${(e && e.message) || e}`;
    }
  }

  async function init() {
    await loadStates();
    decorate();
    // The skills panel renders lazily/repeatedly — decorate whatever appears.
    new MutationObserver(() => decorate())
      .observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
```

- [ ] **Step 2: Append styles to `frontend-overrides/workspace.css`:**

```css
/* --- Skills enable/disable toggle (overlay) --------------------------------- */
.skill-enable-toggle { position: relative; width: 30px; height: 17px; flex: none;
  border-radius: 9px; border: 1px solid rgba(128, 128, 128, 0.5);
  background: rgba(128, 128, 128, 0.25); cursor: pointer; padding: 0; }
.skill-enable-toggle span { position: absolute; top: 1px; left: 1px;
  width: 13px; height: 13px; border-radius: 50%; background: #fff;
  transition: left 0.15s; }
.skill-enable-toggle.on { background: #34c759; border-color: #34c759; }
.skill-enable-toggle.on span { left: 14px; }
```

- [ ] **Step 3: Add the injection block to `scripts/sync-frontend.sh`** — right after the gateway-status.js block added in Task 5:

```bash
  # Inject the skills-toggle add-on once, just before </body> (idempotent).
  SCRIPT_SKT='<script src="/static/js/skills-toggle.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/skills-toggle.js" ]] \
     && ! grep -qF "js/skills-toggle.js" "$INDEX"; then
    awk -v s="  $SCRIPT_SKT" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected skills-toggle.js <script> into index.html"
  fi
```

- [ ] **Step 4: Apply + sanity-check**

Run: `./scripts/sync-frontend.sh && grep -c "skills-toggle.js" frontend/index.html`
Expected: `injected skills-toggle.js <script> into index.html`; grep prints `1`. Re-run sync; grep still prints `1`.

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/skills-toggle.js frontend-overrides/workspace.css scripts/sync-frontend.sh
git commit -m "feat: skill enable/disable toggles overlay"
```

---

### Task 13: Batched live smoke (ONE workspace restart)

All backend changes are committed but the running LaunchAgent still serves old code. Restart ONCE, then walk every feature. Budget 100–190s for the cold start; if the box is disk-thrashing (Spotlight), wait it out — do NOT restart repeatedly.

- [ ] **Step 1: Restart the workspace**

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.workspace
sleep 30 && until curl -sf http://127.0.0.1:8800/api/health >/dev/null; do sleep 10; done; echo UP
```

Expected: `UP` within ~3 minutes.

- [ ] **Step 2: Status endpoint + monitor**

```bash
curl -s http://127.0.0.1:8800/api/gateway/status | python3 -m json.tool
```

Expected: `"state": "ok"`, agents list including `main`, a numeric sessionCount.

- [ ] **Step 3: Browser checks** (over the tailnet, `http://bespin.bicolor-triceratops.ts.net:8800/`):
  - status dot visible in the icon rail, green, tooltip shows session count
  - Cron modal → ⟲ on a job (e.g. a refresh job) → run rows render with status/time/duration
  - Skills panel → toggles render; flip a harmless skill off, confirm green→grey, flip back on (round-trip = gateway write works)
  - Send a chat turn on a cheap prompt asking for step-by-step reasoning → "View thinking process" section appears collapsed (if the probe in Task 8 found no analysis events, skip this check and note it)
  - Mid-stream, hit Stop → stream halts AND the turn dies server-side: `curl -s http://127.0.0.1:8800/api/gateway/status` then confirm via a fresh message that the brain responds (not still busy)
  - Create a throwaway chat, send one line, delete the chat → verify the gateway thread is gone: `.venv/bin/python scripts/purge_orphan_sessions.py` should NOT list it (it's deleted, not orphaned)

- [ ] **Step 4: Restart-awareness check** (combines with a gateway restart you'd do anyway, optional if the box is having a bad day): `launchctl kickstart -k` the GATEWAY agent, watch the workspace dot go amber/red then green, and the banner appear/clear.

- [ ] **Step 5: Record results.** Note any failures honestly; fix-forward with the usual spec/plan update if something diverges (especially the thinking field shape and the cron.runs container key).

- [ ] **Step 6: Final commit if smoke produced fixes**

```bash
git add -A && git status   # review first — commit only intentional changes
git commit -m "fix: post-smoke adjustments for control-ui borrowings"
```
