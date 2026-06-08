# v2 Phase 1 — Robust Connect Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenClaw Workspace connect correctly to *any* user's OpenClaw — derive the agent id instead of hardcoding `main`, support same-host and remote gateways, add a doctor that diagnoses the connection, extend onboarding to connect+verify, and gate account-specific tabs by capability.

**Architecture:** All changes are additive to the existing FastAPI backend (`backend/`) and the shell scripts (`scripts/`). Session keys move from module constants to functions computed from a derived `agent_id()`. A new `backend/doctor.py` and `backend/capabilities.py` are pure-logic modules tested with a mocked `bridge.gateway_call`. The frontend gets one injected add-on (`frontend-overrides/js/capabilities.js`) following the existing `cron.js` pattern.

**Tech Stack:** Python 3.11+, FastAPI, pytest (gateway-free, mock `bridge.gateway_call`), bash, vanilla JS.

**Spec:** `docs/superpowers/specs/2026-06-08-v2-installable-on-any-openclaw-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/config.py` | `agent_id()` + session-key functions; connection.json helpers; gateway_ws from connection.json | Modify |
| `backend/bridge.py` | use `config.session_key()`; add `gateway_hello()` | Modify |
| `backend/app.py` + 6 routers | migrate session-key call sites; add `/api/doctor`, `/api/capabilities` | Modify |
| `backend/doctor.py` | connection checks (reachable/auth/agent-id/methods/version/local) | Create |
| `backend/capabilities.py` | per-tab availability from env/binaries/connection.json | Create |
| `scripts/doctor.sh` | CLI face of the doctor | Create |
| `scripts/setup.sh` | connect + verify + choose-integrations steps | Modify |
| `frontend-overrides/js/capabilities.js` | hide/disable unavailable rail tabs | Create |
| `scripts/sync-frontend.sh` | inject capabilities.js | Modify |
| `backend/tests/test_*.py` | one test file per unit | Create |
| `docs/ARCHITECTURE.md`, `README.md` | method contract + "Connecting to your OpenClaw" | Modify |

---

## Task 1: `agent_id()` + session-key functions (add alongside constants)

**Files:**
- Modify: `backend/config.py` (the session-key block, lines ~46–81)
- Test: `backend/tests/test_agent_id.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_agent_id.py
"""Agent id derivation + session-key builders — the core portability fix.
On a different OpenClaw the agent id is not 'main'; keys must follow it."""
import pytest

from backend import config


@pytest.fixture
def iso(monkeypatch):
    for v in ("OPENCLAW_AGENT_ID", "OPENCLAW_SESSION_KEY", "OPENCLAW_WEB_SESSION_KEY",
              "OPENCLAW_WEB_SESSION_PREFIX", "OPENCLAW_INBOX_TRIAGE_SESSION_KEY"):
        monkeypatch.delenv(v, raising=False)
    # Control what the OpenClaw config "contains".
    monkeypatch.setattr(config, "_openclaw_json", lambda: {})
    monkeypatch.setattr(config, "load_connection", lambda: {})
    return monkeypatch


def test_agent_id_default_is_main(iso):
    assert config.agent_id() == "main"


def test_agent_id_from_openclaw_config(iso):
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "scout"}]}})
    assert config.agent_id() == "scout"


def test_agent_id_env_wins(iso):
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "scout"}]}})
    iso.setenv("OPENCLAW_AGENT_ID", "override")
    assert config.agent_id() == "override"


def test_session_keys_follow_agent_id(iso):
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "scout"}]}})
    assert config.session_key() == "agent:scout:main"
    assert config.web_session_key() == "agent:scout:web"
    assert config.web_session_prefix() == "agent:scout:web"
    assert config.inbox_triage_session_key() == "agent:scout:inbox-triage"


def test_session_key_env_override_wins(iso):
    iso.setenv("OPENCLAW_WEB_SESSION_KEY", "agent:custom:thing")
    assert config.web_session_key() == "agent:custom:thing"


def test_maintainer_parity(iso):
    """agent id 'main' ⇒ keys byte-identical to the v1 constants."""
    iso.setattr(config, "_openclaw_json",
                lambda: {"agents": {"list": [{"id": "main"}]}})
    assert config.session_key() == "agent:main:main"
    assert config.web_session_key() == "agent:main:web"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_agent_id.py -q`
Expected: FAIL — `AttributeError: module 'backend.config' has no attribute 'agent_id'`
(Note: `load_connection` is added in Task 3; in Task 1 the fixture's `monkeypatch.setattr(config, "load_connection", ...)` will fail with AttributeError. To keep Task 1 self-contained, temporarily drop that line — re-add it in Task 3. See Step 3 note.)

- [ ] **Step 3: Write minimal implementation**

In `backend/config.py`, find the session-key block (the comment "Canonical agent session…" through `WEB_SESSION_PREFIX = …`) and **add these functions above the constants** (leave the constants for now — Task 2 removes them):

```python
def agent_id() -> str:
    """The OpenClaw agent id the workspace talks to. Env > OpenClaw config
    (agents.list[0].id) > 'main'. v1 hardcoded 'main'; other installs differ."""
    env = os.environ.get("OPENCLAW_AGENT_ID")
    if env:
        return env
    try:
        return _openclaw_json()["agents"]["list"][0]["id"]
    except (KeyError, IndexError, TypeError):
        return "main"


def session_key() -> str:
    return os.environ.get("OPENCLAW_SESSION_KEY") or f"agent:{agent_id()}:main"


def web_session_key() -> str:
    return os.environ.get("OPENCLAW_WEB_SESSION_KEY") or f"agent:{agent_id()}:web"


def web_session_prefix() -> str:
    return os.environ.get("OPENCLAW_WEB_SESSION_PREFIX") or f"agent:{agent_id()}:web"


def inbox_triage_session_key() -> str:
    return (os.environ.get("OPENCLAW_INBOX_TRIAGE_SESSION_KEY")
            or f"agent:{agent_id()}:inbox-triage")
```

Note for Step 2/3: in Task 1, omit the `monkeypatch.setattr(config, "load_connection", ...)` line from the `iso` fixture (that helper doesn't exist yet). Task 3 adds `load_connection` and re-introduces that line plus an `agent_id`-from-connection test.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_agent_id.py -q`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/config.py backend/tests/test_agent_id.py
git commit -m "feat(config): derive agent_id + session-key functions (alongside constants)"
```

---

## Task 2: Migrate call sites to the functions; remove the constants

**Files:**
- Modify: `backend/bridge.py:85`, `backend/app.py` (3 sites + health), `backend/email_himalaya.py:566`, `backend/research.py:298`, `backend/memory.py:344`, `backend/calendar_google.py:172`, `backend/sessions_store.py:63,73`, `backend/inbox/__init__.py:208`
- Modify: `backend/config.py` (delete the four constants)

- [ ] **Step 1: Replace every call site (mechanical)**

Run this from the repo root (uses the portable detection like sync-frontend.sh):

```bash
if sed --version >/dev/null 2>&1; then SEDI=(-i); else SEDI=(-i ''); fi
grep -rl --include='*.py' -e 'config.SESSION_KEY' -e 'config.WEB_SESSION_KEY' \
  -e 'config.WEB_SESSION_PREFIX' -e 'config.INBOX_TRIAGE_SESSION_KEY' backend \
  | grep -v '/tests/' | grep -v 'config.py' \
  | while read -r f; do
      sed "${SEDI[@]}" \
        -e 's/config\.SESSION_KEY/config.session_key()/g' \
        -e 's/config\.WEB_SESSION_KEY/config.web_session_key()/g' \
        -e 's/config\.WEB_SESSION_PREFIX/config.web_session_prefix()/g' \
        -e 's/config\.INBOX_TRIAGE_SESSION_KEY/config.inbox_triage_session_key()/g' "$f"
    done
```

- [ ] **Step 2: Delete the four constants from `backend/config.py`**

Remove these lines (the `SESSION_KEY`, `WEB_SESSION_KEY`, `INBOX_TRIAGE_SESSION_KEY`, `WEB_SESSION_PREFIX` assignments and their comments). Keep the new functions from Task 1.

- [ ] **Step 3: Verify no constant references remain**

Run: `grep -rn 'config\.\(SESSION_KEY\|WEB_SESSION_KEY\|WEB_SESSION_PREFIX\|INBOX_TRIAGE_SESSION_KEY\)' backend`
Expected: no output (exit 1).

- [ ] **Step 4: Run the full suite**

Run: `.venv/bin/python -m pytest backend/tests -q`
Expected: PASS (all tests — these are behavior-preserving for agent id `main`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(config): session keys follow agent_id everywhere; drop constants"
```

---

## Task 3: Connection config (same-host AND remote)

**Files:**
- Modify: `backend/config.py` (add connection helpers; wire `gateway_ws_url()` + `agent_id()`)
- Test: `backend/tests/test_connection.py` (create); re-add the `load_connection` line to `test_agent_id.py`'s fixture

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_connection.py
"""Connection resolution: env > .data/connection.json > openclaw.json > default.
Password is NEVER sourced from connection.json (a copied .data must not leak it)."""
import json

import pytest

from backend import config


@pytest.fixture
def iso(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CONNECTION_PATH", tmp_path / "connection.json")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    for v in ("OPENCLAW_GATEWAY_WS", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_AGENT_ID"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(config, "_openclaw_json", lambda: {})
    return monkeypatch


def test_gateway_ws_from_connection_file(iso, tmp_path):
    (tmp_path / "connection.json").write_text(json.dumps({"gateway_ws": "ws://box:9999"}))
    assert config.gateway_ws_url() == "ws://box:9999"


def test_gateway_ws_env_wins(iso, tmp_path):
    (tmp_path / "connection.json").write_text(json.dumps({"gateway_ws": "ws://box:9999"}))
    iso.setenv("OPENCLAW_GATEWAY_WS", "ws://env:1")
    assert config.gateway_ws_url() == "ws://env:1"


def test_gateway_ws_default_local(iso):
    assert config.gateway_ws_url().startswith("ws://127.0.0.1:")


def test_agent_id_from_connection_file(iso, tmp_path):
    (tmp_path / "connection.json").write_text(json.dumps({"agent_id": "scout"}))
    assert config.agent_id() == "scout"


def test_password_never_from_connection_file(iso, tmp_path):
    (tmp_path / "connection.json").write_text(json.dumps({"password": "leaked"}))
    assert config.gateway_password() in (None, "")  # not "leaked"


def test_save_connection_merges(iso, tmp_path):
    config.save_connection(gateway_ws="ws://a")
    config.save_connection(agent_id="scout")  # must not wipe gateway_ws
    saved = json.loads((tmp_path / "connection.json").read_text())
    assert saved == {"gateway_ws": "ws://a", "agent_id": "scout"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_connection.py -q`
Expected: FAIL — `AttributeError: … 'CONNECTION_PATH'`

- [ ] **Step 3: Write minimal implementation**

In `backend/config.py`, add near the branding helpers:

```python
CONNECTION_PATH = DATA_DIR / "connection.json"


def load_connection() -> dict:
    """Read .data/connection.json (non-secret connection info). Never raises."""
    try:
        return json.loads(CONNECTION_PATH.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save_connection(**fields) -> dict:
    """Merge non-secret connection fields into connection.json, atomically.
    NEVER persist a password here — secrets stay in env / openclaw.json."""
    current = load_connection()
    current.update({k: v for k, v in fields.items()
                    if v is not None and k != "password"})
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONNECTION_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(current, indent=2) + "\n")
    tmp.replace(CONNECTION_PATH)
    return current
```

Then update `gateway_ws_url()`:

```python
def gateway_ws_url() -> str:
    return (os.environ.get("OPENCLAW_GATEWAY_WS")
            or load_connection().get("gateway_ws")
            or f"ws://127.0.0.1:{gateway_port()}")
```

And update `agent_id()` to consult connection.json (between env and openclaw config):

```python
def agent_id() -> str:
    env = os.environ.get("OPENCLAW_AGENT_ID")
    if env:
        return env
    conn = load_connection().get("agent_id")
    if conn:
        return conn
    try:
        return _openclaw_json()["agents"]["list"][0]["id"]
    except (KeyError, IndexError, TypeError):
        return "main"
```

Re-add to `test_agent_id.py`'s `iso` fixture the line
`monkeypatch.setattr(config, "load_connection", lambda: {})` (it now exists).

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_connection.py backend/tests/test_agent_id.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/config.py backend/tests/test_connection.py backend/tests/test_agent_id.py
git commit -m "feat(config): connection.json layer (same-host + remote), password kept out of it"
```

---

## Task 4: Gateway hello helper (bridge)

**Files:**
- Modify: `backend/bridge.py` (add `gateway_hello()` near `gateway_call`)
- Test: `backend/tests/test_gateway_hello.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_gateway_hello.py
"""gateway_hello returns the connect-response payload (version/caps) and raises
RuntimeError when the handshake is rejected — same failure contract as gateway_call."""
import asyncio

import pytest

from backend import bridge


class _FakeWS:
    def __init__(self, hello):
        self._hello = hello

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def test_gateway_hello_returns_payload(monkeypatch):
    async def fake_request(ws, method, params=None):
        return {"ok": True, "payload": {"version": "2026.6.1"}}

    monkeypatch.setattr(bridge, "_request", fake_request)
    monkeypatch.setattr(bridge, "_wait_for_challenge",
                        lambda ws: asyncio.sleep(0))
    monkeypatch.setattr(bridge.websockets, "connect",
                        lambda *a, **k: _FakeWS(None))
    out = asyncio.run(bridge.gateway_hello())
    assert out["version"] == "2026.6.1"


def test_gateway_hello_raises_on_reject(monkeypatch):
    async def fake_request(ws, method, params=None):
        return {"ok": False, "error": "AUTH_PASSWORD_MISSING"}

    monkeypatch.setattr(bridge, "_request", fake_request)
    monkeypatch.setattr(bridge, "_wait_for_challenge",
                        lambda ws: asyncio.sleep(0))
    monkeypatch.setattr(bridge.websockets, "connect",
                        lambda *a, **k: _FakeWS(None))
    with pytest.raises(RuntimeError, match="connect failed"):
        asyncio.run(bridge.gateway_hello())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_gateway_hello.py -q`
Expected: FAIL — `AttributeError: module 'backend.bridge' has no attribute 'gateway_hello'`

- [ ] **Step 3: Write minimal implementation**

In `backend/bridge.py`, directly after `gateway_call` (after line ~275):

```python
async def gateway_hello(timeout: float = 10.0) -> dict:
    """Connect + auth and return the gateway's connect-response payload (version,
    capabilities, …) without making a further call. Raises RuntimeError on a
    rejected handshake; lets connection errors (OSError/TimeoutError) propagate."""
    url = config.gateway_ws_url()
    async with asyncio.timeout(timeout):
        async with websockets.connect(url, max_size=None, open_timeout=30,
                                      ping_interval=None) as ws:
            await _wait_for_challenge(ws)
            hello = await _request(ws, "connect", _connect_params())
    if not hello.get("ok"):
        raise RuntimeError(f"gateway connect failed: {hello}")
    return hello.get("payload") or {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_gateway_hello.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/bridge.py backend/tests/test_gateway_hello.py
git commit -m "feat(bridge): gateway_hello() helper (connect payload for the doctor)"
```

---

## Task 5: Doctor backend (`backend/doctor.py` + `/api/doctor`)

**Files:**
- Create: `backend/doctor.py`
- Modify: `backend/app.py` (import + `@app.get("/api/doctor")`)
- Test: `backend/tests/test_doctor.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_doctor.py
"""Doctor maps gateway states (reachable/auth/unknown-method) to {ok, hint}."""
import asyncio
import socket

import pytest

from backend import doctor


def _run(monkeypatch, hello=None, call=None):
    async def fake_hello(timeout=10.0):
        if isinstance(hello, Exception):
            raise hello
        return hello if hello is not None else {}

    async def fake_call(method, params=None, timeout=30.0):
        if isinstance(call, Exception):
            raise call
        if callable(call):
            return call(method)
        return {}

    monkeypatch.setattr(doctor.bridge, "gateway_hello", fake_hello)
    monkeypatch.setattr(doctor.bridge, "gateway_call", fake_call)
    return asyncio.run(doctor.run_checks())


def _check(result, cid):
    return next(c for c in result if c["id"] == cid)


def test_unreachable_gateway(monkeypatch):
    res = _run(monkeypatch, hello=ConnectionRefusedError())
    assert _check(res, "gateway_reachable")["ok"] is False
    assert "unreachable" in _check(res, "gateway_reachable")["hint"].lower()


def test_auth_rejected(monkeypatch):
    res = _run(monkeypatch, hello=RuntimeError("gateway connect failed: AUTH"))
    c = _check(res, "gateway_reachable")
    assert c["ok"] is False and "password" in c["hint"].lower()


def test_healthy_gateway_and_methods(monkeypatch):
    res = _run(monkeypatch, hello={"version": "2026.6.1"},
               call=lambda m: {"ok": True})
    assert _check(res, "gateway_reachable")["ok"] is True
    assert _check(res, "methods")["ok"] is True
    assert "2026.6.1" in _check(res, "openclaw_version")["detail"]


def test_missing_method(monkeypatch):
    def call(m):
        if m == "skills.status":
            raise RuntimeError("skills.status failed: unknown method")
        return {"ok": True}
    res = _run(monkeypatch, hello={}, call=call)
    c = _check(res, "methods")
    assert c["ok"] is False and "skills.status" in c["detail"]


def test_aggregate_ok_is_and_of_fatals(monkeypatch):
    res = _run(monkeypatch, hello=ConnectionRefusedError())
    assert doctor.summarize(res)["ok"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_doctor.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.doctor'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/doctor.py
"""Connection doctor: diagnose this workspace's link to the user's OpenClaw.
Read-only — never sends a chat turn or mutates gateway state. Used by both
GET /api/doctor and scripts/doctor.sh."""
from __future__ import annotations

import asyncio

from . import bridge, config

# The gateway methods the workspace depends on (the compatibility contract).
REQUIRED_METHODS = [
    "chat.send", "chat.abort", "chat.history",
    "sessions.create", "sessions.delete", "sessions.patch", "sessions.json",
    "models.list", "models.authStatus",
    "cron.list", "cron.run", "cron.runs", "cron.update",
    "skills.status", "skills.update",
]
# Only these read-only ones are safe to actually invoke as a probe.
PROBE_METHODS = ["models.list", "skills.status", "cron.list", "sessions.json"]


def _ok(cid, detail="", hint=""):
    return {"id": cid, "ok": True, "detail": detail, "hint": hint}


def _fail(cid, detail="", hint=""):
    return {"id": cid, "ok": False, "detail": detail, "hint": hint}


async def _check_reachable() -> tuple[dict, dict | None]:
    """Returns (check, hello_or_None). hello is None when unreachable/rejected."""
    try:
        hello = await bridge.gateway_hello(timeout=8)
        return _ok("gateway_reachable", config.gateway_ws_url()), hello
    except RuntimeError as e:  # handshake/auth rejected
        return _fail("gateway_reachable", str(e),
                     "gateway rejected auth — check the gateway password "
                     "(OPENCLAW_GATEWAY_PASSWORD or openclaw.json)"), None
    except (OSError, asyncio.TimeoutError) as e:  # connect refused/timeout/DNS
        return _fail("gateway_reachable", f"{type(e).__name__}: {e}",
                     f"gateway unreachable at {config.gateway_ws_url()} — "
                     "check it's running and OPENCLAW_GATEWAY_WS"), None


async def _check_methods() -> dict:
    missing = []
    for m in PROBE_METHODS:
        try:
            await bridge.gateway_call(m, timeout=8)
        except RuntimeError as e:
            if "connect failed" in str(e):
                return _fail("methods", "gateway down during probe",
                             "fix gateway_reachable first")
            missing.append(m)  # "<m> failed: ..." → method missing/incompatible
        except (OSError, asyncio.TimeoutError):
            return _fail("methods", "gateway down during probe",
                         "fix gateway_reachable first")
    if missing:
        return _fail("methods", "missing: " + ", ".join(missing),
                     "your OpenClaw is missing methods the workspace needs — "
                     "update OpenClaw")
    return _ok("methods", f"probed {len(PROBE_METHODS)} read-only methods")


def _check_agent_id() -> dict:
    import os
    src = ("env" if os.environ.get("OPENCLAW_AGENT_ID")
           else "connection.json" if config.load_connection().get("agent_id")
           else "openclaw.json" if _from_openclaw() else "default-guess")
    aid = config.agent_id()
    if src == "default-guess":
        return _fail("agent_id", f"{aid} (guessed)",
                     "could not read agents.list[0].id — set OPENCLAW_AGENT_ID "
                     "if your agent isn't named 'main'")
    return _ok("agent_id", f"{aid} (from {src})")


def _from_openclaw() -> bool:
    try:
        config._openclaw_json()["agents"]["list"][0]["id"]
        return True
    except (KeyError, IndexError, TypeError):
        return False


def _check_version(hello: dict | None) -> dict:
    if not hello:
        return _fail("openclaw_version", "unknown (gateway unreachable)", "")
    ver = hello.get("version") or hello.get("build") or hello.get("protocol")
    return _ok("openclaw_version", f"{ver}" if ver else "unknown (not reported)")


async def run_checks() -> list[dict]:
    reachable, hello = await _check_reachable()
    checks = [reachable, _check_agent_id(), _check_version(hello)]
    if reachable["ok"]:
        checks.append(await _check_methods())
    else:
        checks.append(_fail("methods", "skipped (gateway unreachable)", ""))
    return checks


def summarize(checks: list[dict]) -> dict:
    return {"ok": all(c["ok"] for c in checks), "checks": checks}
```

Then in `backend/app.py`, add the import (`from . import … doctor …`) and the route near `/api/health`:

```python
@app.get("/api/doctor")
async def api_doctor():
    """Diagnose the OpenClaw connection (read-only)."""
    return doctor.summarize(await doctor.run_checks())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_doctor.py -q`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/doctor.py backend/app.py backend/tests/test_doctor.py
git commit -m "feat(doctor): /api/doctor — diagnose the OpenClaw connection (read-only)"
```

---

## Task 6: `scripts/doctor.sh` (CLI face)

**Files:**
- Create: `scripts/doctor.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Diagnose the workspace's connection to OpenClaw. If a server URL is given (or
# SMOKE_URL is set), query its /api/doctor; otherwise run an in-process check.
#
# Usage:  scripts/doctor.sh [http://127.0.0.1:8800]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:-${SMOKE_URL:-}}"

render() {  # reads JSON {ok, checks:[{id,ok,detail,hint}]} on stdin
  python3 -c '
import json,sys
d=json.load(sys.stdin)
for c in d["checks"]:
    mark="\033[32mok\033[0m  " if c["ok"] else "\033[31mFAIL\033[0m"
    line=f"  {mark} {c[\"id\"]}: {c.get(\"detail\",\"\")}"
    print(line)
    if not c["ok"] and c.get("hint"): print(f"        ↳ {c[\"hint\"]}")
sys.exit(0 if d["ok"] else 1)'
}

echo "OpenClaw Workspace — connection doctor"
if [[ -n "$URL" ]]; then
  curl -fsS --max-time 20 "$URL/api/doctor" | render
else
  ( cd "$ROOT" && ./.venv/bin/python -c '
import asyncio, json
from backend import doctor
print(json.dumps(doctor.summarize(asyncio.run(doctor.run_checks()))))' ) | render
fi
```

- [ ] **Step 2: Make it executable and syntax-check**

Run: `chmod +x scripts/doctor.sh && bash -n scripts/doctor.sh && echo ok`
Expected: `ok`

- [ ] **Step 3: Run it (static, gateway may be down)**

Run: `scripts/doctor.sh`
Expected: prints checks; exits non-zero if the gateway is unreachable (that's correct).

- [ ] **Step 4: Commit**

```bash
git add scripts/doctor.sh
git commit -m "feat(doctor): scripts/doctor.sh CLI (in-process or via /api/doctor)"
```

---

## Task 7: Capabilities backend (`backend/capabilities.py` + `/api/capabilities`)

> **Design note (deviation from spec):** the spec suggested each backend module
> expose its own `capability()`. For Phase 1 this uses a single, data-driven
> `capabilities.py` registry (one small check function per tab) instead — same
> outcome (no hardcoded UI switch), far less coupling to wire now. Revisit if a
> future tab needs richer, module-local capability logic.

**Files:**
- Create: `backend/capabilities.py`
- Modify: `backend/app.py` (import + route)
- Test: `backend/tests/test_capabilities.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_capabilities.py
"""Per-tab availability from binaries/config/connection-enable. Core tabs are
always available; account tabs report available:false with a reason+hint."""
import pytest

from backend import capabilities as caps


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(caps.config, "load_connection", lambda: {})
    return monkeypatch


def test_core_tabs_always_available(env):
    m = caps.snapshot()
    for tab in ("chat", "memory", "skills", "cron", "notes", "documents"):
        assert m[tab]["available"] is True


def test_email_unavailable_without_himalaya(env):
    env.setattr(caps.shutil, "which", lambda _: None)
    m = caps.snapshot()
    assert m["email"]["available"] is False
    assert "himalaya" in m["email"]["reason"].lower()


def test_email_needs_enable_even_with_binary(env, tmp_path):
    env.setattr(caps.shutil, "which", lambda _: "/usr/local/bin/himalaya")
    env.setattr(caps, "_himalaya_config_present", lambda: True)
    # integration not enabled in connection.json
    m = caps.snapshot()
    assert m["email"]["available"] is False
    assert "enable" in m["email"]["hint"].lower()


def test_email_available_when_enabled_and_present(env):
    env.setattr(caps.shutil, "which", lambda _: "/usr/local/bin/himalaya")
    env.setattr(caps, "_himalaya_config_present", lambda: True)
    env.setattr(caps.config, "load_connection",
                lambda: {"integrations": {"email": True}})
    m = caps.snapshot()
    assert m["email"]["available"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_capabilities.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.capabilities'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/capabilities.py
"""Which tabs are usable on THIS install. Core (OpenClaw-native) tabs are always
on; account-specific tabs require their tool/config AND being enabled in
connection.json's "integrations". Drives /api/capabilities so the frontend can
hide/disable what won't work instead of erroring."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from . import config

CORE_TABS = ["chat", "memory", "skills", "cron", "sessions", "notes", "documents", "models"]


def _enabled(name: str) -> bool:
    return bool(config.load_connection().get("integrations", {}).get(name))


def _himalaya_config_present() -> bool:
    cfg = os.environ.get("HIMALAYA_CONFIG") or str(
        Path.home() / ".config" / "himalaya" / "config.toml")
    return Path(cfg).expanduser().exists()


def _avail(ok, reason="", hint=""):
    return {"available": bool(ok), "reason": reason, "hint": hint}


def _email() -> dict:
    if not shutil.which(os.environ.get("HIMALAYA_BIN") or "himalaya"):
        return _avail(False, "himalaya not installed",
                      "install himalaya, then: setup.sh --enable email")
    if not _himalaya_config_present():
        return _avail(False, "no himalaya config",
                      "configure ~/.config/himalaya/config.toml")
    if not _enabled("email"):
        return _avail(False, "not enabled", "enable with: setup.sh --enable email")
    return _avail(True)


def _calendar() -> dict:
    keys = Path(os.environ.get("GOOGLE_OAUTH_KEYS")
                or Path.home() / ".gmail-mcp/gcp-oauth.keys.json").expanduser()
    toks = Path(os.environ.get("GOOGLE_CAL_TOKENS")
                or Path.home() / ".config/google-calendar-mcp/tokens.json").expanduser()
    if not (keys.exists() and toks.exists()):
        return _avail(False, "no Google OAuth creds/tokens",
                      "provide Google OAuth creds, then: setup.sh --enable calendar")
    if not _enabled("calendar"):
        return _avail(False, "not enabled", "enable with: setup.sh --enable calendar")
    return _avail(True)


def _inbox() -> dict:
    if not _enabled("inbox"):
        return _avail(False, "not enabled", "enable with: setup.sh --enable inbox")
    return _avail(True)


def snapshot() -> dict:
    out = {t: _avail(True) for t in CORE_TABS}
    out["email"] = _email()
    out["calendar"] = _calendar()
    out["inbox"] = _inbox()
    return out
```

In `backend/app.py`, add the import and route:

```python
@app.get("/api/capabilities")
async def api_capabilities():
    """Which tabs are usable on this install (drives UI gating)."""
    return capabilities.snapshot()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_capabilities.py -q`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/capabilities.py backend/app.py backend/tests/test_capabilities.py
git commit -m "feat(capabilities): /api/capabilities — data-driven tab availability"
```

---

## Task 8: Frontend capability gating (`capabilities.js` + injection)

**Files:**
- Create: `frontend-overrides/js/capabilities.js`
- Modify: `scripts/sync-frontend.sh` (inject the script, mirror cron.js block); `frontend-overrides/index.html` (add the `<script>` tag — both places, per the override README)

- [ ] **Step 1: Write the add-on**

```javascript
// frontend-overrides/js/capabilities.js
// Hide/disable rail tabs the backend reports as unavailable on this install
// (account-specific tabs without their config). Same injected-<script> pattern
// as cron.js/inbox.js; survives upstream updates as long as #icon-rail exists.
(function () {
  // capability key -> rail button id (core tabs are always available, skipped)
  var RAIL = {
    email: 'rail-email',
    calendar: 'rail-calendar',
    inbox: 'rail-inbox',       // injected by inbox.js
    research: 'rail-research',
  };
  function apply(caps) {
    Object.keys(RAIL).forEach(function (key) {
      var cap = caps[key];
      if (!cap) return;
      var btn = document.getElementById(RAIL[key]);
      if (!btn) return;
      if (cap.available) { btn.hidden = false; return; }
      btn.hidden = true;                       // hide unavailable tab
      btn.title = (cap.hint || cap.reason || 'unavailable');
    });
  }
  function load() {
    fetch('/api/capabilities').then(function (r) { return r.json(); })
      .then(apply).catch(function () { /* leave tabs as-is on error */ });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load, { once: true });
  } else { load(); }
})();
```

- [ ] **Step 2: Add the injection to `scripts/sync-frontend.sh`**

After the `skills-toggle.js` injection block (before the closing `fi` of the overrides section), add a copy of that block for capabilities.js:

```bash
  # Inject the capabilities gating add-on once, before </body> (idempotent).
  SCRIPT_CAP='<script src="/static/js/capabilities.js" defer></script>'
  if [[ -f "$INDEX" ]] && [[ -f "$OVERRIDES/js/capabilities.js" ]] \
     && ! grep -qF "js/capabilities.js" "$INDEX"; then
    awk -v s="  $SCRIPT_CAP" '
      { lines[NR] = $0 }
      END {
        for (i = 1; i <= NR; i++) {
          if (!done && lines[i] ~ /<\/body>/) { print s; done = 1 }
          print lines[i]
        }
      }
    ' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
    echo "injected capabilities.js <script> into index.html"
  fi
```

Also add the same `<script src="/static/js/capabilities.js" defer></script>` line near the other add-on tags in `frontend-overrides/index.html` (per the override README: tags belong in BOTH the injector and the index.html override).

- [ ] **Step 3: Build and verify the tag + file land**

Run:
```bash
WORKSPACE_AGENT_NAME=Gary WORKSPACE_BUILD_DEST=/tmp/capcheck bash scripts/sync-frontend.sh >/dev/null
grep -c "js/capabilities.js" /tmp/capcheck/index.html
test -f /tmp/capcheck/js/capabilities.js && echo "file ok"
rm -rf /tmp/capcheck
```
Expected: `1` then `file ok`.

- [ ] **Step 4: Commit**

```bash
git add frontend-overrides/js/capabilities.js frontend-overrides/index.html scripts/sync-frontend.sh
git commit -m "feat(ui): capabilities.js hides rail tabs unavailable on this install"
```

---

## Task 9: Onboarding — extend `setup.sh` (connect + verify + integrations)

**Files:**
- Modify: `scripts/setup.sh`
- Modify: `.github/workflows/ci.yml` (smoke uses `--skip-connect`)

- [ ] **Step 1: Add flags + the connect/integrations steps**

In `scripts/setup.sh`, add to the flag parser: `--gateway-ws <url>`, `--enable <csv>`, `--skip-connect`. After the accent step and before the persist step, add:

```bash
# --- Connection (skippable) -------------------------------------------------
if [[ "$SKIP_CONNECT" != 1 ]]; then
  GW_CONFIG="${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json"
  if [[ -z "$GATEWAY_WS" && -f "$GW_CONFIG" ]]; then
    echo "  Found OpenClaw config at $GW_CONFIG (same-host) — using it."
  elif [[ -z "$GATEWAY_WS" && "$ASSUME_YES" != 1 ]]; then
    printf "  Gateway WebSocket URL [ws://127.0.0.1:18789]: "
    read -r GATEWAY_WS || true
  fi
fi

# --- Persist branding + connection -----------------------------------------
python3 - "$BRANDING" "$NAME" "$ACCENT" "$GATEWAY_WS" "$ENABLE" <<'PY'
import json, sys
path, name, accent, gw, enable = sys.argv[1:6]
try: data = json.load(open(path))
except Exception: data = {}
data["agent_name"] = name.strip() or "Claw"
data["accent"] = accent.strip() or "#4fe3d1"
json.dump(data, open(path, "w"), indent=2); open(path, "a").write("\n")
PY
```

Then write connection.json (separate file) and run the doctor:

```bash
if [[ "$SKIP_CONNECT" != 1 ]]; then
  CONN="$DATA_DIR/connection.json"
  python3 - "$CONN" "$GATEWAY_WS" "$ENABLE" <<'PY'
import json, sys
path, gw, enable = sys.argv[1:4]
try: data = json.load(open(path))
except Exception: data = {}
if gw.strip(): data["gateway_ws"] = gw.strip()
ints = data.get("integrations", {})
for name in [s for s in enable.split(",") if s.strip()]:
    ints[name.strip()] = True
data["integrations"] = ints
json.dump(data, open(path, "w"), indent=2); open(path, "a").write("\n")
PY
  echo "  verifying connection…"
  scripts/doctor.sh || echo "  (doctor reported issues — fix and re-run scripts/doctor.sh)"
fi
```

Add the flag variables near the top (`GATEWAY_WS=""`, `ENABLE=""`, `SKIP_CONNECT=0`) and parse them in the `while` loop.

- [ ] **Step 2: Verify non-interactive path**

Run: `scripts/setup.sh --name Gary --yes --skip-connect`
Expected: writes branding, builds frontend, prints next steps; no connection prompt.

- [ ] **Step 3: Verify connection.json is written when integrations are enabled**

Run:
```bash
scripts/setup.sh --name Gary --yes --gateway-ws ws://127.0.0.1:18789 --enable email,inbox
python3 -c "import json;d=json.load(open('.data/connection.json'));print(d['gateway_ws'],d['integrations'])"
```
Expected: `ws://127.0.0.1:18789 {'email': True, 'inbox': True}`

(Then restore the maintainer's connection.json if needed: `rm -f .data/connection.json` — the live deploy reads gateway from openclaw.json regardless.)

- [ ] **Step 4: Point CI smoke at `--skip-connect`**

In `.github/workflows/ci.yml`, change the build step to:
`run: scripts/setup.sh --name CI --yes --skip-connect`

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.sh .github/workflows/ci.yml
git commit -m "feat(setup): connect + verify + choose-integrations onboarding steps"
```

---

## Task 10: Docs — method contract + "Connecting to your OpenClaw"

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `README.md`, `scripts/smoke.sh`

- [ ] **Step 1: Add the method-contract table to `docs/ARCHITECTURE.md`**

Under "## The bridge", add:

```markdown
### Gateway method contract

The workspace requires the gateway to speak these methods (probed read-only ones
are verified by `scripts/doctor.sh`):

`chat.send`, `chat.abort`, `chat.history`; `sessions.create/delete/patch/json`;
`models.list`, `models.authStatus`; `cron.list/run/runs/update`;
`skills.status/update`.

If your OpenClaw is older and missing one, the doctor reports it. Minimum tested
OpenClaw: see the README.
```

- [ ] **Step 2: Add a "Connecting to your OpenClaw" section to `README.md`**

After "## Requirements", add:

```markdown
## Connecting to your OpenClaw

- **Same host** (workspace runs on the OpenClaw machine): nothing to configure —
  it reads `~/.openclaw/openclaw.json` for the gateway URL, password, and agent id.
- **Remote** OpenClaw: set `OPENCLAW_GATEWAY_WS=ws://host:18789` and
  `OPENCLAW_GATEWAY_PASSWORD=…` (the password is never written to disk by setup).
- If your agent isn't named `main`, it's read from `agents.list[0].id`; override
  with `OPENCLAW_AGENT_ID`.

Run `scripts/doctor.sh` any time to verify the connection.
```

- [ ] **Step 3: Have `smoke.sh` mention the doctor**

In `scripts/smoke.sh`, after the gateway-config check, add:
```bash
echo "  (run scripts/doctor.sh to verify the live gateway connection)"
```

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md README.md scripts/smoke.sh
git commit -m "docs: gateway method contract + Connecting-to-your-OpenClaw guide"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite: `.venv/bin/python -m pytest backend/tests -q` → all pass.
- [ ] Run `scripts/smoke.sh` → all static checks pass.
- [ ] Fresh-clone test: clone to a temp dir, `setup.sh --name TestBot --yes --skip-connect`, `pytest`, confirm `from backend.app import app` imports and `/api/doctor` + `/api/capabilities` routes exist (`grep -c 'api/doctor\|api/capabilities' backend/app.py`).
- [ ] Maintainer parity: with no env overrides and agent id `main`, `config.web_session_key() == "agent:main:web"` (in `test_agent_id.py`).
- [ ] Update `docs/SHIPPING.md` Tier/Phase status and commit.
