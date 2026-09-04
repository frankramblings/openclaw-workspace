"""gateway_admin: the thin RPC helpers Pillar D routes call, and the error
mapping that turns a gateway message into an HTTP status."""
import asyncio

import pytest

from backend import gateway_admin as gw
from backend.tests.fake_gateway import FakeGateway


def run(coro):
    return asyncio.run(coro)


def test_call_returns_payload_and_records_params(monkeypatch):
    fake = FakeGateway({"agents.list": {"defaultId": "main", "agents": [{"id": "main"}]}}).install(monkeypatch)
    out = run(gw.agents_list())
    assert out["defaultId"] == "main"
    assert fake.calls == [("agents.list", {})]


def test_call_raises_gateway_error_on_ok_false(monkeypatch):
    FakeGateway().error("skills.proposals.reject", "INVALID_REQUEST",
                        "Only pending proposals can be rejected. Current status: applied.").install(monkeypatch)
    with pytest.raises(gw.GatewayError) as ei:
        run(gw.proposals_reject("main", "p1", "no"))
    assert ei.value.code == "INVALID_REQUEST"
    assert ei.value.method == "skills.proposals.reject"
    assert "Only pending" in ei.value.message


def test_config_patch_sends_json_fragment_and_base_hash(monkeypatch):
    fake = FakeGateway({"config.patch": {"ok": True, "path": "/tmp/openclaw.json"}}).install(monkeypatch)
    run(gw.config_patch({"mcp": {"servers": {"x": None}}}, "abc123", note="test"))
    (method, params), = fake.calls
    assert method == "config.patch"
    assert params["baseHash"] == "abc123"
    assert params["note"] == "test"
    import json
    assert json.loads(params["raw"]) == {"mcp": {"servers": {"x": None}}}


def test_helpers_send_exact_params(monkeypatch):
    fake = FakeGateway({
        "agents.files.get": {"file": {"name": "SOUL.md"}},
        "agents.files.set": {"ok": True},
        "agents.files.list": {"files": []},
        "skills.proposals.list": {"proposals": []},
        "skills.proposals.inspect": {"record": {}},
        "skills.proposals.apply": {"ok": True},
        "logs.tail": {"lines": []},
        "config.get": {"hash": "h"},
    }).install(monkeypatch)
    run(gw.agent_files_get("main", "SOUL.md"))
    run(gw.agent_files_set("main", "SOUL.md", "hi"))
    run(gw.agent_files_list("main"))
    run(gw.proposals_list("main"))
    run(gw.proposals_inspect("main", "p1"))
    run(gw.proposals_apply("main", "p1", "ok"))
    run(gw.proposals_apply("main", "p2", None))
    run(gw.logs_tail(None, 50, 1000))
    run(gw.logs_tail(12, 5, 100))
    run(gw.config_get())
    assert fake.calls == [
        ("agents.files.get", {"agentId": "main", "name": "SOUL.md"}),
        ("agents.files.set", {"agentId": "main", "name": "SOUL.md", "content": "hi"}),
        ("agents.files.list", {"agentId": "main"}),
        ("skills.proposals.list", {"agentId": "main"}),
        ("skills.proposals.inspect", {"agentId": "main", "proposalId": "p1"}),
        ("skills.proposals.apply", {"agentId": "main", "proposalId": "p1", "reason": "ok"}),
        ("skills.proposals.apply", {"agentId": "main", "proposalId": "p2"}),
        ("logs.tail", {"limit": 50, "maxBytes": 1000}),
        ("logs.tail", {"cursor": 12, "limit": 5, "maxBytes": 100}),
        ("config.get", {}),
    ]


def test_proposals_list_accepts_list_or_wrapped_payload(monkeypatch):
    FakeGateway({"skills.proposals.list": [{"id": "a"}]}).install(monkeypatch)
    assert run(gw.proposals_list("main")) == [{"id": "a"}]
    FakeGateway({"skills.proposals.list": {"proposals": [{"id": "b"}]}}).install(monkeypatch)
    assert run(gw.proposals_list("main")) == [{"id": "b"}]


def test_default_agent_id_uses_default_id_and_caches(monkeypatch):
    fake = FakeGateway({"agents.list": {"defaultId": "main", "agents": [{"id": "main"}, {"id": "qwen"}]}}).install(monkeypatch)
    gw._AGENT_CACHE.update(id=None, ts=0.0)
    clock = {"t": 1000.0}
    monkeypatch.setattr(gw.time, "monotonic", lambda: clock["t"])
    assert run(gw.default_agent_id()) == "main"
    clock["t"] += 30
    assert run(gw.default_agent_id()) == "main"
    assert len(fake.calls) == 1
    clock["t"] += 31
    assert run(gw.default_agent_id()) == "main"
    assert len(fake.calls) == 2


def test_default_agent_id_falls_back_to_first_agent(monkeypatch):
    FakeGateway({"agents.list": {"agents": [{"id": "solo"}]}}).install(monkeypatch)
    gw._AGENT_CACHE.update(id=None, ts=0.0)
    assert run(gw.default_agent_id()) == "solo"


def test_default_agent_id_raises_without_agents(monkeypatch):
    FakeGateway({"agents.list": {"agents": []}}).install(monkeypatch)
    gw._AGENT_CACHE.update(id=None, ts=0.0)
    with pytest.raises(gw.GatewayError):
        run(gw.default_agent_id())


@pytest.mark.parametrize("message,status,code", [
    ("unknown method: mcp.servers", 501, "gateway_unsupported"),
    ('unknown agent id "nope"', 404, "not_found"),
    ("Skill proposal not found: p9", 404, "not_found"),
    ("Only pending proposals can be applied. Current status: applied.", 409, "not_pending"),
    ("Proposal scan failed; proposal was quarantined.", 409, "quarantined"),
    ("config changed since last load; re-run config.get and retry", 409, "stale_config"),
    ("config base hash required; re-run config.get and retry", 409, "stale_config"),
    ('unsupported file "NOPE.md"', 400, "bad_name"),
    ('unsafe workspace file "../x"', 400, "bad_name"),
    ("invalid config: mcp.servers.x.url must be a URL", 502, "gateway_error"),
])
def test_http_error_maps_gateway_messages(message, status, code):
    st, cd, detail = gw.http_error(gw.GatewayError("m", "INVALID_REQUEST", message))
    assert (st, cd) == (status, code)
    assert detail == message


def test_http_error_maps_connection_failures():
    assert gw.http_error(TimeoutError())[:2] == (502, "gateway_unreachable")
    assert gw.http_error(OSError("refused"))[:2] == (502, "gateway_unreachable")
    assert gw.http_error(RuntimeError("gateway connect failed: x"))[:2] == (502, "gateway_unreachable")


def test_error_response_is_the_envelope():
    r = gw.error_response(gw.GatewayError("m", "INVALID_REQUEST", "Skill proposal not found: p"))
    assert r.status_code == 404
    import json
    assert json.loads(r.body) == {"ok": False, "error": "not_found", "detail": "Skill proposal not found: p"}
