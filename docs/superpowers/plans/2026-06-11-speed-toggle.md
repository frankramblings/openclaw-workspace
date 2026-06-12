# Speed Toggle + Honest Spinner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-chat ⚡Fast/Normal/🧠Deep toggle that maps to the gateway's per-turn `thinking` override (low/—/high), plus an honest "Model is thinking…" spinner driven by a new `run_alive` SSE frame.

**Architecture:** Thinking-only toggle (user decision — never changes the model; orthogonal to the picker). `speed` persists on the session record and rides the existing PATCH endpoint; `chat_stream` maps it to a `thinking` kwarg that `_open_turn` puts into `chat.send` params. `run_alive` is emitted by `_relay_events` on the first run-activity frame; chat.js uses it to replace canned staged spinner messages with truth.

**Tech Stack:** Python 3.14/FastAPI/pytest (`backend/`), vanilla-JS SPA (`frontend-overrides/`).

**Spec:** `docs/superpowers/specs/2026-06-11-speed-toggle-and-honest-spinner-design.md`

**House rules (binding):** repo has other sessions' uncommitted work — `git add` ONLY files you touched; NO headless Chrome (node --check + user smoke); never edit `frontend/` (only `frontend-overrides/` + `./scripts/sync-frontend.sh`); all commands from `/Users/admin/openclaw-workspace`.

**New contracts:**
- Session record field `speed`: `"fast" | "normal" | "deep"`; readers use `.get("speed") or "normal"` (old records lack the key).
- chat.send param: `"thinking": "low" | "high"` (absent for normal — payload byte-identical to today).
- SSE frame `{"type": "run_alive"}` — once per relay, on first run-activity frame.

---

### Task 1: `speed` on the session record + PATCH endpoint

**Files:**
- Modify: `backend/sessions_store.py` (`create` ~line 66, `update` allowed-set ~line 92)
- Modify: `backend/app.py` (`patch_session` ~line 493)
- Test: `backend/tests/test_speed_toggle.py` (create)

- [ ] **Step 1: Write the failing tests** — create `backend/tests/test_speed_toggle.py`:

```python
"""Per-chat speed setting: store round-trip, PATCH validation, turn mapping."""
import pytest

from backend import sessions_store


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions_store, "STORE_PATH", tmp_path / "sessions.json")
    # in-memory cache, if the module keeps one — reset it (read the module;
    # adapt this fixture to its actual persistence shape)
    yield


def test_create_defaults_speed_normal():
    rec = sessions_store.create(name="t")
    assert rec["speed"] == "normal"


def test_update_round_trips_speed():
    rec = sessions_store.create(name="t")
    sessions_store.update(rec["id"], speed="fast")
    assert sessions_store.get(rec["id"])["speed"] == "fast"


def test_old_records_without_speed_read_as_normal():
    rec = sessions_store.create(name="t")
    rec.pop("speed", None)  # simulate a pre-speed record
    assert (rec.get("speed") or "normal") == "normal"
```

NOTE to implementer: read `sessions_store.py` first — the fixture must match its real persistence (file path constant name, any module-level cache). If the store's tests already have an isolation fixture (check `backend/tests/conftest.py` and existing store tests), reuse that pattern instead.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/admin/openclaw-workspace && python3 -m pytest backend/tests/test_speed_toggle.py -q`
Expected: FAIL — `KeyError: 'speed'`

- [ ] **Step 3: Implement store side** — in `sessions_store.py::create`, next to `"model": model or "openclaw",` add:

```python
        "speed": "normal",   # thinking depth: fast|normal|deep (web toggle)
```

and in `update`'s `allowed` set add `"speed"`.

- [ ] **Step 4: Implement endpoint side** — in `app.py::patch_session`, add the form field and validation:

```python
async def patch_session(session_id: str, name: str = Form(default=None),
                        model: str = Form(default=None), folder: str = Form(default=None),
                        endpoint_url: str = Form(default=None),
                        endpoint_id: str = Form(default=None),
                        speed: str = Form(default=None)):
    if speed is not None and speed not in ("fast", "normal", "deep"):
        speed = None   # invalid value → ignored, like other bad fields
    fields = {k: v for k, v in {
        "name": name, "model": model, "folder": folder,
        "endpoint_url": endpoint_url, "endpoint_id": endpoint_id,
        "speed": speed,
    }.items() if v is not None}
```

(rest of the function unchanged)

- [ ] **Step 5: Add the endpoint test** — append to `test_speed_toggle.py` (use the project's existing FastAPI test-client pattern — see `backend/tests/test_chat_stream_draft.py` for how it builds a client; reuse its fixture style including the `_isolated_data_dir` idiom if present):

```python
def test_patch_endpoint_accepts_valid_and_ignores_invalid_speed(client_factory):
    # adapt to the real client fixture; the assertions are what matter:
    # PATCH speed=deep -> record's speed == "deep"
    # PATCH speed=warp -> record's speed unchanged
    ...
```

Write this as a REAL test against the actual client fixture (the `...` above is a placeholder for you to fill with the project's idiom — no placeholders may remain in the committed test).

- [ ] **Step 6: Run + full suite**

Run: `python3 -m pytest backend/tests/test_speed_toggle.py -q && python3 -m pytest backend/tests/ -q`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add backend/sessions_store.py backend/app.py backend/tests/test_speed_toggle.py
git commit -m "feat: per-chat speed field (fast/normal/deep) on session records"
```

---

### Task 2: `thinking` pass-through in the bridge

**Files:**
- Modify: `backend/bridge.py` (`stream_turn` signature + both `_open_turn` call sites incl. the stall-retry one; `_open_turn` signature + send_params)
- Test: `backend/tests/test_speed_toggle.py` (append)

- [ ] **Step 1: Failing tests** — append:

```python
import asyncio
import json

from backend import bridge


def test_open_turn_includes_thinking_when_set(monkeypatch):
    sent = {}

    class WS:
        async def send(self, raw):
            sent.update(json.loads(raw))

    async def fake_connect():
        return WS()

    async def fake_await_response(ws, req_id):
        return {"ok": True, "payload": {"runId": "r1"}}

    monkeypatch.setattr(bridge, "_connect_and_auth", fake_connect)
    monkeypatch.setattr(bridge, "_await_response", fake_await_response)
    monkeypatch.setattr(bridge._warm, "ws", None)

    asyncio.run(bridge._open_turn("hi", "k", None, None, None,
                                  allow_warm=False, thinking="low"))
    assert sent["params"]["thinking"] == "low"


def test_open_turn_omits_thinking_by_default(monkeypatch):
    sent = {}

    class WS:
        async def send(self, raw):
            sent.update(json.loads(raw))

    async def fake_connect():
        return WS()

    async def fake_await_response(ws, req_id):
        return {"ok": True, "payload": {"runId": "r1"}}

    monkeypatch.setattr(bridge, "_connect_and_auth", fake_connect)
    monkeypatch.setattr(bridge, "_await_response", fake_await_response)
    monkeypatch.setattr(bridge._warm, "ws", None)

    asyncio.run(bridge._open_turn("hi", "k", None, None, None,
                                  allow_warm=False))
    assert "thinking" not in sent["params"]
```

NOTE: `_open_turn` promotes fresh sockets to the warm slot and may acquire `_warm.lock` — after each call assert/restore clean state if needed (release via the documented semantics, or monkeypatch `_warm` wholesale with a fresh `_Warm()`-like object; read the existing `test_warm_lock_released_when_retry_holds_it` for the established pattern and keep these tests leak-free the same way).

Also append a stall-retry-preserves-thinking test, modeled exactly on the existing `_wire_stall` tests in `test_stall_watchdog.py` (import or replicate the small helpers locally — don't refactor that file):

```python
def test_stall_retry_preserves_thinking(monkeypatch):
    seen_thinking = []

    async def fake_open_turn(message, session_key, model_ref, attachments,
                             run_info, allow_warm, thinking=None):
        seen_thinking.append(thinking)
        run_id = f"r{len(seen_thinking)}"
        if run_info is not None:
            run_info["runId"] = run_id

        class _S:
            name = "OPEN"

        class _WS:
            state = _S()

            async def close(self):
                pass

        return _WS(), run_id, False

    calls = {"n": 0}

    async def stall_once(ws, run_id, run_info=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise bridge._RunStalled(240)
        yield bridge._sse({"delta": "ok"})

    async def fake_gateway_call(method, params=None, timeout=30.0):
        return {"ok": True, "payload": {}}

    monkeypatch.setattr(bridge, "_open_turn", fake_open_turn)
    monkeypatch.setattr(bridge, "gateway_call", fake_gateway_call)
    monkeypatch.setattr(bridge, "_relay_events", stall_once)

    async def go():
        return [c async for c in bridge.stream_turn("hi", session_key="k",
                                                    thinking="low")]

    asyncio.run(go())
    assert seen_thinking == ["low", "low"]
```

- [ ] **Step 2: verify failure** — `python3 -m pytest backend/tests/test_speed_toggle.py -q` → TypeError on `thinking` kwarg.

- [ ] **Step 3: Implement** — in `bridge.py`:

(a) `_open_turn` signature gains trailing `thinking: str | None = None`; after the `send_params` dict literal (with `deliver`/`idempotencyKey`), add:

```python
        if thinking:
            # Per-turn thinking override (verified: chat.send p.thinking →
            # thinkingLevelOverride). Nothing persists gateway-side.
            send_params["thinking"] = thinking
```

(b) `stream_turn` signature gains `thinking: str | None = None` (after `attachments`, before `run_info`); pass `thinking=thinking` at BOTH `_open_turn` call sites: the initial open, the dead-warm-socket retry open (the `except (...)` one), AND the stall-retry open at the bottom of the retry loop — three sites total; grep `_open_turn(` to be sure.

- [ ] **Step 4: Run** — `python3 -m pytest backend/tests/test_speed_toggle.py backend/tests/test_stall_watchdog.py -q` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/bridge.py backend/tests/test_speed_toggle.py
git commit -m "feat: per-turn thinking override threaded through the bridge"
```

---

### Task 3: speed→thinking mapping in chat_stream

**Files:**
- Modify: `backend/app.py` (`chat_stream`: resolve speed, pass `thinking=` to `bridge.stream_turn`)
- Test: `backend/tests/test_speed_toggle.py` (append)

- [ ] **Step 1: Failing test** — append a pure-function test plus mapping constant:

```python
def test_speed_maps_to_thinking():
    from backend.app import _thinking_for_speed
    assert _thinking_for_speed("fast") == "low"
    assert _thinking_for_speed("deep") == "high"
    assert _thinking_for_speed("normal") is None
    assert _thinking_for_speed(None) is None
    assert _thinking_for_speed("warp") is None
```

- [ ] **Step 2: verify failure**, then implement in `app.py` (near `_model_ref`):

```python
_SPEED_THINKING = {"fast": "low", "deep": "high"}


def _thinking_for_speed(speed: str | None) -> str | None:
    """Map the chat's speed setting to chat.send's per-turn thinking override.
    normal (and anything unknown) sends NO override — the default path stays
    byte-identical to pre-toggle behavior."""
    return _SPEED_THINKING.get(speed or "")
```

and in `chat_stream`'s `gen()`, the `bridge.stream_turn(...)` call gains:

```python
                                                  thinking=_thinking_for_speed(
                                                      (rec or {}).get("speed")),
```

(`rec` is the session record already in scope.)

- [ ] **Step 3: Integration test** — append a test driving `/api/chat_stream` with the project's client fixture (same pattern as `test_chat_stream_draft.py`, INCLUDING patching `config.DATA_DIR` to tmp_path — telemetry isolation): fake `bridge.stream_turn` capturing its kwargs; create a session with `speed="fast"`; POST a message; assert captured `thinking == "low"`. Then PATCH speed to normal and assert a second turn captures `thinking is None`.

- [ ] **Step 4: Run** — `python3 -m pytest backend/tests/test_speed_toggle.py -q && python3 -m pytest backend/tests/ -q` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app.py backend/tests/test_speed_toggle.py
git commit -m "feat: chat turns carry the chat's speed as a thinking override"
```

---

### Task 4: `run_alive` SSE frame

**Files:**
- Modify: `backend/bridge.py` (`_relay_events`, the `_is_run_activity` branch)
- Test: `backend/tests/test_stall_watchdog.py` (append — it owns the relay tests)

- [ ] **Step 1: Failing tests** — append to `test_stall_watchdog.py`:

```python
def test_run_alive_emitted_once_before_first_delta(monkeypatch):
    _fast_watchdog(monkeypatch, notice=10.0, cap=20.0)

    async def go():
        return [json.loads(c[5:]) for c in
                [x async for x in bridge._relay_events(SilentWS([
                    {"type": "event", "event": "chat",
                     "payload": {"runId": "r1", "deltaText": "a"}},
                    {"type": "event", "event": "chat",
                     "payload": {"runId": "r1", "deltaText": "b"}},
                    {"type": "event", "event": "agent",
                     "payload": {"runId": "r1", "stream": "lifecycle",
                                 "data": {"phase": "end"}}},
                ]), "r1")]]

    out = asyncio.run(go())
    assert out[0] == {"type": "run_alive"}
    assert [f for f in out if f.get("type") == "run_alive"] == [{"type": "run_alive"}]
    assert {"delta": "a"} in out and {"delta": "b"} in out


def test_no_run_alive_without_activity(monkeypatch):
    # Other runs' frames are not OUR activity — no run_alive for them.
    _fast_watchdog(monkeypatch, notice=10.0, cap=0.05)

    async def go():
        out = []
        with pytest.raises(bridge._RunStalled):
            async for c in bridge._relay_events(SilentWS([
                {"type": "event", "event": "chat",
                 "payload": {"runId": "OTHER", "deltaText": "x"}},
            ]), "r1"):
                out.append(json.loads(c[5:]))
        return out

    out = asyncio.run(go())
    assert not any(f.get("type") == "run_alive" for f in out)
```

- [ ] **Step 2: verify failure**, then implement — in `_relay_events`, the activity branch currently reads (post-watchdog, verify exact text):

```python
        if _is_run_activity(payload, run_id):
            now = time.monotonic()
            timing.setdefault("t_first_frame", now)
            last_activity = now
```

becomes:

```python
        if _is_run_activity(payload, run_id):
            now = time.monotonic()
            if "t_first_frame" not in timing:
                timing["t_first_frame"] = now
                # First proof of life: tell the SPA the model is actually
                # working so it can stop guessing with canned captions.
                yield _sse({"type": "run_alive"})
            last_activity = now
```

CAREFUL: `timing` is `{}` (a throwaway dict) when `run_info is None` — the frame still emits exactly once in that case because the throwaway dict still records the key. Fine. Note `run_alive` must NOT set `text_seen`/`failed` in app.py's gen() — it has no `delta`/`exit_code` keys, so no change needed there (do not add any).

- [ ] **Step 3: Run** — `python3 -m pytest backend/tests/test_stall_watchdog.py -q && python3 -m pytest backend/tests/ -q` → green.

- [ ] **Step 4: Commit**

```bash
git add backend/bridge.py backend/tests/test_stall_watchdog.py
git commit -m "feat: run_alive SSE frame on first gateway activity"
```

---

### Task 5: Speed toggle UI

**Files:**
- Modify: `frontend-overrides/index.html` (composer, next to the model picker `#model-picker-wrap` ~line 1107)
- Modify: `frontend-overrides/js/sessions.js` (state + PATCH + sync on session select; it owns session records and the model picker)

No JS test infra; verification = `node --check` + user smoke.

- [ ] **Step 1: Markup** — in `index.html`, immediately before `<div class="model-picker-wrap" id="model-picker-wrap">`:

```html
          <button type="button" class="input-icon-btn" id="speed-toggle-btn"
                  title="Speed: Normal — click to change" data-speed="normal">
            <span id="speed-toggle-label">Normal</span>
          </button>
```

(match the composer's existing `input-icon-btn` idiom — see `#web-toggle-btn` ~line 1059; reuse its classes so theming applies. If the composer buttons are icon-only, keep the short text label anyway — three states need a visible word.)

- [ ] **Step 2: Wiring** — in `sessions.js`, add near `getCurrentModel`:

```js
const SPEED_ORDER = ['normal', 'fast', 'deep'];
const SPEED_META = {
  fast:   { label: '⚡ Fast',  title: 'Speed: Fast — low thinking, quickest replies' },
  normal: { label: 'Normal',  title: 'Speed: Normal — default thinking' },
  deep:   { label: '🧠 Deep', title: 'Speed: Deep — high thinking, best answers' },
};

function _renderSpeed(speed) {
  const btn = document.getElementById('speed-toggle-btn');
  if (!btn) return;
  const meta = SPEED_META[speed] || SPEED_META.normal;
  btn.dataset.speed = speed;
  btn.querySelector('#speed-toggle-label').textContent = meta.label;
  btn.title = meta.title + ' — click to change';
}

export function getCurrentSpeed() {
  const sess = sessions.find(x => x.id === currentSessionId);
  return (sess && sess.speed) || 'normal';
}

export function initSpeedToggle() {
  const btn = document.getElementById('speed-toggle-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const cur = btn.dataset.speed || 'normal';
    const next = SPEED_ORDER[(SPEED_ORDER.indexOf(cur) + 1) % SPEED_ORDER.length];
    _renderSpeed(next);                       // optimistic
    const sess = sessions.find(x => x.id === currentSessionId);
    if (sess) sess.speed = next;              // local cache
    const sid = currentSessionId;
    if (!sid) return;                         // pending chat: applied at create? No — v1: toggle is inert until the session exists
    const fd = new FormData();
    fd.append('speed', next);
    try {
      await fetch(`${API_BASE}/api/session/${sid}`, { method: 'PATCH', body: fd });
    } catch (e) { console.warn('speed save failed:', e); }
  });
}
```

Call `_renderSpeed(getCurrentSpeed())` wherever the current session's UI is synced on selection (find where `selectSession`/session-load updates the model-picker label — same place; grep `model-picker-label` assignments in sessions.js). Call `initSpeedToggle()` from the module's init path (find where other composer controls are wired — likely an `init`/setup function already exported and called by app.js; follow that pattern, don't invent a new entry point).

Pending-chat note (v1 scope): before the first message creates the session record, the toggle renders but a click only updates the button locally; the value is NOT carried into session creation. Acceptable — flip it after the first reply. Add a one-line comment saying so.

- [ ] **Step 3: Syntax + deploy**

Run: `node --input-type=module --check < frontend-overrides/js/sessions.js && echo OK`
Run: `./scripts/sync-frontend.sh | tail -1`

- [ ] **Step 4: Commit**

```bash
git add frontend-overrides/index.html frontend-overrides/js/sessions.js
git commit -m "feat: per-chat speed toggle (Fast/Normal/Deep) in the composer"
```

---

### Task 6: Honest spinner — `run_alive` handler

**Files:**
- Modify: `frontend-overrides/js/chat.js` (staged-message chain ~lines 844-900; SSE dispatch chain — insert branch next to the `stall` branch ~line 1907)

- [ ] **Step 1: Flag + staged-message suppression** — in the send flow, right before the staged `setTimeout` chain (the block that schedules `'Checking model endpoint'` / `'Still waiting for model'` / endpoint-offline countdown, ~line 855), declare:

```js
      let _runAlive = false;   // backend confirmed the model is working
```

Then add `_runAlive ||` to the existing early-exit guard of EACH staged callback. The chain's callbacks already start with guards like `if (accumulated || !spinner || !spinner.element || (currentAbort && currentAbort.signal.aborted)) return;` — extend to `if (_runAlive || accumulated || !spinner || ...) return;`. Apply to every staged callback in that block (read it fully; there are ~3-4 including the countdown's interval — for the interval add the check inside its tick too so an in-flight countdown stops).

- [ ] **Step 2: Dispatch branch** — insert BEFORE the `stall` branch (so reading order matches frame order):

```js
              } else if (json.type === 'run_alive') {
                _extendTimeout();              // proof of life, same as stall frames
                if (_isBg) continue;
                _runAlive = true;
                if (spinner && spinner.element && !accumulated) {
                  spinner.updateMessage('Model is thinking…');
                }
              } else if (json.type === 'stall') {
```

(`_extendTimeout`, `_isBg`, `spinner`, `accumulated` are all in scope — same closure as the stall branches. NOTE: `_runAlive = true` must come AFTER the `_isBg` check? No — set it before the `_isBg` check? Think: `_runAlive` is per-send-closure state; a background stream's own closure flag should still be set so ITS staged messages stop. Set `_runAlive = true` BEFORE `if (_isBg) continue;` — only the spinner DOM update is foreground-gated. Final order: `_extendTimeout(); _runAlive = true; if (_isBg) continue; if (spinner...) {...}`.)

Use that corrected order in the actual edit:

```js
              } else if (json.type === 'run_alive') {
                _extendTimeout();              // proof of life, same as stall frames
                _runAlive = true;              // stop the canned staged captions
                if (_isBg) continue;
                if (spinner && spinner.element && !accumulated) {
                  spinner.updateMessage('Model is thinking…');
                }
              } else if (json.type === 'stall') {
```

- [ ] **Step 3: Syntax + deploy**

Run: `node --input-type=module --check < frontend-overrides/js/chat.js && echo OK`
Run: `./scripts/sync-frontend.sh | tail -1`

- [ ] **Step 4: Commit**

```bash
git add frontend-overrides/js/chat.js
git commit -m "feat: 'Model is thinking' spinner truth from run_alive; retire canned captions once alive"
```

---

### Task 7: Full suite, restart, smoke

**Files:** none (verification only)

- [ ] **Step 1:** `python3 -m pytest backend/tests/ -q` — all green; run twice; confirm `.data/turn_timings.jsonl` not created by tests.
- [ ] **Step 2:** `launchctl kickstart -k "gui/$(id -u)/ai.openclaw.workspace"`, poll `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8800/api/config` until 200.
- [ ] **Step 3 (user smoke, report what to check):** toggle cycles Normal→⚡Fast→🧠Deep and persists across reload; a Fast turn shows "Model is thinking…" at ~2s and first text in ~3-6s on gpt-5.5; a Normal turn behaves exactly as before; `tail .data/turn_timings.jsonl` shows the Fast turn's smaller `first_text_ms`.
- [ ] **Step 4:** Final whole-implementation review (controller dispatches it), then report.

---

## Self-review notes (planning time)

- Spec §1→Task 1, §2→Tasks 2-3, §3→Task 5, §4→Tasks 4+6, testing section→each task + Task 7. Out-of-scope items absent.
- Contract consistency: `speed` values (fast/normal/deep) identical across store/endpoint/mapping/UI; `thinking` values (low/high) only produced by `_thinking_for_speed`; `run_alive` frame name identical in bridge emit, relay tests, chat.js branch.
- Deliberate choices: normal sends NO thinking param (not "medium") so default-path payloads are byte-identical; pending chats' toggle inert until the record exists (v1); `_runAlive` set before the `_isBg` gate (closure-local, background streams keep their own staged captions suppressed).
