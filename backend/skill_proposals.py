"""Skill proposals (the gateway's skill workshop): list, inspect, apply,
reject. The gateway owns the proposal store (~/.openclaw/skill-workshop) and
does every write; this backend gates, backs up, relays and audits.

apply: the gateway re-hashes the draft, re-scans it (a failing scan
quarantines the proposal instead of applying), writes rollback.json into the
proposal dir, then writes <workspace>/skills/<name>/SKILL.md and hot-reloads
skills. Only pending proposals can be applied or rejected.
skills.proposals.list payload shape as observed on the live gateway on
2026-09-03: an object with keys "schema", "updatedAt", "proposals" (a bare
list under the "proposals" key); gateway_admin.proposals_list accepts a bare
list or a {"proposals": [...]} / {"items": [...]} wrapper."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Body

from . import agent_config_store as store
from . import gateway_admin as gw

router = APIRouter()
REASON_MAX = 2000
STATUSES = ("pending", "applied", "rejected", "quarantined", "stale")


class BadRequest(ValueError):
    pass


def map_entry(e: dict) -> dict:
    return {"id": e.get("id"), "kind": e.get("kind"), "status": e.get("status"),
            "title": e.get("title"), "description": e.get("description"),
            "skill_name": e.get("skillName"), "skill_key": e.get("skillKey"),
            "created_at": e.get("createdAt"), "updated_at": e.get("updatedAt"),
            "scan_state": e.get("scanState")}


def sort_entries(entries: list[dict]) -> list[dict]:
    """Pending first, then newest updated_at first (ISO strings sort)."""
    by_time = sorted(entries, key=lambda m: str(m.get("updated_at") or ""), reverse=True)
    return sorted(by_time, key=lambda m: 0 if m.get("status") == "pending" else 1)


def count_statuses(entries: list[dict]) -> dict:
    counts = {s: 0 for s in STATUSES}
    for e in entries:
        s = e.get("status")
        if s in counts:
            counts[s] += 1
    return counts


def _reason(body) -> str | None:
    reason = (body or {}).get("reason") if isinstance(body, dict) else None
    if reason is None:
        return None
    if not isinstance(reason, str) or len(reason) > REASON_MAX:
        raise BadRequest(f"reason must be a string of at most {REASON_MAX} characters")
    return reason.strip() or None


async def _agent(agent: str | None) -> str:
    return agent if agent else await gw.default_agent_id()


def _guard():
    if not store.writes_enabled():
        return gw.fail(503, "writes_disabled", "WORKSPACE_AGENT_CONFIG_WRITES=0")
    return None


@router.get("/api/skill-proposals")
async def list_proposals(agent: str | None = None):
    try:
        agent_id = await _agent(agent)
        raw = await gw.proposals_list(agent_id)
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    entries = sort_entries([map_entry(e) for e in raw])
    return {"ok": True, "agent_id": agent_id, "counts": count_statuses(entries), "proposals": entries}


@router.get("/api/skill-proposals/{proposal_id}")
async def inspect_proposal(proposal_id: str, agent: str | None = None):
    try:
        agent_id = await _agent(agent)
        detail = await gw.proposals_inspect(agent_id, proposal_id)
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    return {"ok": True, "agent_id": agent_id, "proposal": detail.get("record") or {},
            "content": detail.get("content") or "", "support_files": detail.get("supportFiles") or []}


async def _pending_record(agent_id: str, proposal_id: str, verb: str):
    """(record, None) or (None, error response)."""
    detail = await gw.proposals_inspect(agent_id, proposal_id)
    record = detail.get("record") or {}
    if record.get("status") != "pending":
        return None, gw.fail(409, "not_pending",
                             f"Only pending proposals can be {verb}. Current status: {record.get('status')}.")
    return record, None


@router.post("/api/skill-proposals/{proposal_id}/apply")
async def apply_proposal(proposal_id: str, agent: str | None = None, body: dict = Body(default=None)):
    if (denied := _guard()) is not None:
        return denied
    try:
        reason = _reason(body)
    except BadRequest as exc:
        return gw.fail(400, "bad_request", str(exc))
    try:
        agent_id = await _agent(agent)
        record, err = await _pending_record(agent_id, proposal_id, "applied")
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    if err is not None:
        return err
    target = record.get("target") or {}
    skill_file = target.get("skillFile") if isinstance(target.get("skillFile"), str) else None
    skill_name = target.get("skillName") or proposal_id
    backup_id = None
    if skill_file and Path(skill_file).is_file():
        try:
            backup_id = store.backup("skill-target", skill_name, Path(skill_file).read_text(encoding="utf-8"),
                                     {"proposal_id": proposal_id, "path": skill_file})["id"]
        except OSError as exc:
            store.audit("proposal.apply", proposal_id, False, detail=f"backup failed: {exc}", skill=skill_name)
            return gw.fail(500, "backup_failed", f"cannot back up {skill_file}: {exc}")
    try:
        await gw.proposals_apply(agent_id, proposal_id, reason)
    except Exception as exc:  # noqa: BLE001
        store.audit("proposal.apply", proposal_id, False, detail=str(exc), skill=skill_name)
        return gw.error_response(exc)
    try:
        after = (await gw.proposals_inspect(agent_id, proposal_id)).get("record") or {**record, "status": "applied"}
    except Exception:  # noqa: BLE001
        after = {**record, "status": "applied"}
    store.audit("proposal.apply", proposal_id, True, skill=skill_name, backup_id=backup_id)
    return {"ok": True, "agent_id": agent_id, "proposal": after, "installed": skill_file, "backup_id": backup_id}


@router.post("/api/skill-proposals/{proposal_id}/reject")
async def reject_proposal(proposal_id: str, agent: str | None = None, body: dict = Body(default=None)):
    if (denied := _guard()) is not None:
        return denied
    try:
        reason = _reason(body)
    except BadRequest as exc:
        return gw.fail(400, "bad_request", str(exc))
    try:
        agent_id = await _agent(agent)
        record, err = await _pending_record(agent_id, proposal_id, "rejected")
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    if err is not None:
        return err
    try:
        backup_id = store.backup("proposal-record", proposal_id, json.dumps(record, indent=2, sort_keys=True),
                                 {"action": "reject", "reason": reason or ""})["id"]
    except OSError as exc:
        store.audit("proposal.reject", proposal_id, False, detail=f"backup failed: {exc}")
        return gw.fail(500, "backup_failed", f"cannot back up proposal {proposal_id!r}: {exc}")
    try:
        await gw.proposals_reject(agent_id, proposal_id, reason)
    except Exception as exc:  # noqa: BLE001
        store.audit("proposal.reject", proposal_id, False, detail=str(exc), backup_id=backup_id)
        return gw.error_response(exc)
    store.audit("proposal.reject", proposal_id, True, backup_id=backup_id, reason=reason or "")
    return {"ok": True, "agent_id": agent_id,
            "proposal": {**record, "status": "rejected", "statusReason": reason}, "backup_id": backup_id}
