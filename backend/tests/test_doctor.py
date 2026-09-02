"""Doctor maps gateway states (reachable/auth/unknown-method) to {ok, hint}."""
import asyncio


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


def test_bad_url_is_structured_fail_not_crash(monkeypatch):
    # A misconfigured ws URL raises a WebSocketException — the doctor must report
    # a structured FAIL, never let it crash run_checks (which would be HTTP 500).
    import websockets.exceptions
    res = _run(monkeypatch, hello=websockets.exceptions.WebSocketException("bad url"))
    assert _check(res, "gateway_reachable")["ok"] is False


def test_aggregate_ok_is_and_of_fatals(monkeypatch):
    res = _run(monkeypatch, hello=ConnectionRefusedError())
    assert doctor.summarize(res)["ok"] is False


def test_missing_steer_patch_is_optional_and_does_not_fail_the_run(monkeypatch):
    # The claude-cli steer patch is optional: without it the workspace still
    # works (the composer queues instead of steering). It must report its own
    # FAIL line + hint but never make scripts/doctor.sh exit 1 on a fresh
    # install (which printed "doctor reported issues" from scripts/setup.sh).
    monkeypatch.setattr(doctor.steer, "patch_present", lambda dist_dir=None: False)
    res = _run(monkeypatch, hello={"version": "2026.6.1"}, call=lambda m: {"ok": True})
    steer_check = _check(res, "steer_patch")
    assert steer_check["ok"] is False
    assert steer_check["optional"] is True
    assert "claude-cli-steer.py" in steer_check["detail"]
    assert doctor.summarize(res)["ok"] is True


def test_non_optional_failure_still_flips_summary_ok(monkeypatch):
    monkeypatch.setattr(doctor.steer, "patch_present", lambda dist_dir=None: True)
    res = _run(monkeypatch, hello={"version": "2026.6.1"}, call=lambda m: {"ok": True})
    assert doctor.summarize(res)["ok"] is True
    res.append({"id": "made_up", "ok": False, "detail": "", "hint": ""})
    assert doctor.summarize(res)["ok"] is False
