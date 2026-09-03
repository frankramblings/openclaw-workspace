"""Skill proposals: list/inspect relay, apply and reject with pre-write backups
and audit, status gates, kill switch."""
import json

import pytest
from fastapi.testclient import TestClient

from backend import agent_config_store as store
from backend import gateway_admin as gw
from backend import skill_proposals
from backend.app import app
from backend.tests.fake_gateway import FakeGateway

ENTRIES = [
    {"id": "old-applied", "kind": "create", "status": "applied", "title": "Old", "description": "d",
     "skillName": "old", "skillKey": "old", "createdAt": "2026-08-01T00:00:00Z", "updatedAt": "2026-08-02T00:00:00Z", "scanState": "clean"},
    {"id": "p-new", "kind": "create", "status": "pending", "title": "New skill", "description": "d",
     "skillName": "new-skill", "skillKey": "new-skill", "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-02T00:00:00Z", "scanState": "clean"},
    {"id": "p-older", "kind": "update", "status": "pending", "title": "Older", "description": "d",
     "skillName": "existing", "skillKey": "existing", "createdAt": "2026-08-20T00:00:00Z", "updatedAt": "2026-08-21T00:00:00Z", "scanState": "failed"},
    {"id": "rej", "kind": "create", "status": "rejected", "title": "R", "description": "d",
     "skillName": "r", "skillKey": "r", "createdAt": "2026-08-10T00:00:00Z", "updatedAt": "2026-08-11T00:00:00Z", "scanState": "clean"},
]


def record(pid, status, skill_file, skill_name="existing"):
    return {"record": {"id": pid, "status": status, "kind": "update", "title": "t",
                       "target": {"skillName": skill_name, "skillKey": skill_name,
                                  "skillDir": str(skill_file.parent), "skillFile": str(skill_file)}},
            "content": "---\nstatus: proposal\n---\n# body\n", "supportFiles": []}


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _agent_cache_reset():
    gw._AGENT_CACHE.update(id=None, ts=0.0)


def base(tmp_path, status="pending", with_target=True):
    skill_file = tmp_path / "skills" / "existing" / "SKILL.md"
    if with_target:
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text("# current skill\n")
    return skill_file, {
        "agents.list": {"defaultId": "main", "agents": [{"id": "main"}]},
        "skills.proposals.list": {"proposals": ENTRIES},
        "skills.proposals.inspect": lambda p: record(p["proposalId"], status, skill_file),
        "skills.proposals.apply": {"ok": True},
        "skills.proposals.reject": {"ok": True},
    }


def test_list_counts_and_orders_pending_first_newest_first(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path)
    fake = FakeGateway(resp).install(monkeypatch)
    r = client.get("/api/skill-proposals")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["agent_id"] == "main"
    assert body["counts"] == {"pending": 2, "applied": 1, "rejected": 1, "quarantined": 0, "stale": 0}
    assert [p["id"] for p in body["proposals"]] == ["p-new", "p-older", "rej", "old-applied"]
    assert body["proposals"][0] == {"id": "p-new", "kind": "create", "status": "pending", "title": "New skill",
                                    "description": "d", "skill_name": "new-skill", "skill_key": "new-skill",
                                    "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
                                    "scan_state": "clean"}
    assert fake.calls_for("skills.proposals.list") == [{"agentId": "main"}]


def test_list_honors_agent_query_without_agents_list_call(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path)
    fake = FakeGateway(resp).install(monkeypatch)
    assert client.get("/api/skill-proposals?agent=qwen").json()["agent_id"] == "qwen"
    assert fake.calls_for("agents.list") == [] and fake.calls_for("skills.proposals.list") == [{"agentId": "qwen"}]


def test_inspect_relays_record_content_and_support_files(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path)
    FakeGateway(resp).install(monkeypatch)
    r = client.get("/api/skill-proposals/p-older")
    assert r.status_code == 200
    body = r.json()
    assert body["proposal"]["id"] == "p-older" and body["content"].startswith("---") and body["support_files"] == []


def test_inspect_missing_is_404(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path)
    FakeGateway(resp).error("skills.proposals.inspect", "INVALID_REQUEST", "Skill proposal not found: zz").install(monkeypatch)
    r = client.get("/api/skill-proposals/zz")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_apply_backs_up_target_then_applies_and_audits(client, monkeypatch, tmp_path):
    skill_file, resp = base(tmp_path)
    fake = FakeGateway(resp).install(monkeypatch)
    r = client.post("/api/skill-proposals/p-older/apply", json={"reason": "looks good"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["installed"] == str(skill_file)
    assert fake.calls_for("skills.proposals.apply") == [{"agentId": "main", "proposalId": "p-older", "reason": "looks good"}]
    backups = store.list_backups("skill-target", "existing")
    assert len(backups) == 1 and backups[0]["id"] == body["backup_id"]
    assert store.read_backup("skill-target", "existing", body["backup_id"]) == "# current skill\n"
    assert backups[0]["meta"]["proposal_id"] == "p-older"
    entry = store.recent_audit()[0]
    assert entry["action"] == "proposal.apply" and entry["ok"] is True and entry["skill"] == "existing"
    assert [m for m, _ in fake.calls].count("skills.proposals.inspect") == 2


def test_apply_without_existing_target_has_no_backup(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path, with_target=False)
    FakeGateway(resp).install(monkeypatch)
    r = client.post("/api/skill-proposals/p-new/apply", json={})
    assert r.status_code == 200 and r.json()["backup_id"] is None
    assert store.list_backups("skill-target", "existing") == []


def test_apply_non_pending_is_409_without_gateway_apply(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path, status="applied")
    fake = FakeGateway(resp).install(monkeypatch)
    r = client.post("/api/skill-proposals/old-applied/apply", json={})
    assert r.status_code == 409 and r.json()["error"] == "not_pending"
    assert fake.calls_for("skills.proposals.apply") == [] and store.recent_audit() == []


def test_apply_quarantined_by_scan_is_409_and_audited(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path)
    FakeGateway(resp).error("skills.proposals.apply", "INVALID_REQUEST",
                            "Proposal scan failed; proposal was quarantined.").install(monkeypatch)
    r = client.post("/api/skill-proposals/p-older/apply", json={})
    assert r.status_code == 409 and r.json()["error"] == "quarantined"
    assert store.recent_audit()[0]["ok"] is False


def test_apply_reason_must_be_a_short_string(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path)
    fake = FakeGateway(resp).install(monkeypatch)
    assert client.post("/api/skill-proposals/p-older/apply", json={"reason": 5}).status_code == 400
    assert client.post("/api/skill-proposals/p-older/apply", json={"reason": "x" * 2001}).status_code == 400
    assert fake.calls == []


def test_reject_backs_up_record_then_rejects(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path)
    fake = FakeGateway(resp).install(monkeypatch)
    r = client.post("/api/skill-proposals/p-older/reject", json={"reason": "duplicate"})
    assert r.status_code == 200, r.text
    assert fake.calls_for("skills.proposals.reject") == [{"agentId": "main", "proposalId": "p-older", "reason": "duplicate"}]
    backups = store.list_backups("proposal-record", "p-older")
    assert len(backups) == 1
    assert json.loads(store.read_backup("proposal-record", "p-older", backups[0]["id"]))["id"] == "p-older"
    assert store.recent_audit()[0]["action"] == "proposal.reject"


def test_reject_non_pending_is_409(client, monkeypatch, tmp_path):
    _, resp = base(tmp_path, status="rejected")
    fake = FakeGateway(resp).install(monkeypatch)
    assert client.post("/api/skill-proposals/rej/reject", json={}).status_code == 409
    assert fake.calls_for("skills.proposals.reject") == []


def test_writes_disabled_blocks_apply_and_reject(client, monkeypatch, tmp_path):
    monkeypatch.setenv("WORKSPACE_AGENT_CONFIG_WRITES", "0")
    _, resp = base(tmp_path)
    fake = FakeGateway(resp).install(monkeypatch)
    assert client.post("/api/skill-proposals/p-older/apply", json={}).status_code == 503
    assert client.post("/api/skill-proposals/p-older/reject", json={}).status_code == 503
    assert fake.calls == []


def test_pure_helpers():
    assert skill_proposals.count_statuses(ENTRIES)["pending"] == 2
    assert [e["id"] for e in skill_proposals.sort_entries([skill_proposals.map_entry(e) for e in ENTRIES])] == \
        ["p-new", "p-older", "rej", "old-applied"]
