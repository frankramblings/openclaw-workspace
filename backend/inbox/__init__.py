"""Unified Inbox: native collectors merged behind /api/items.

Replaces the triage-dashboard proxy (the dashboard was a wedged pre-alpha;
decision + design in docs/superpowers/specs/2026-06-05-native-inbox-design.md).
Each source fetches concurrently with per-source error isolation; local
dismiss/snooze state filters the merge. Response keeps the dashboard's shape:
{items, total, sources: {name: count}, errors: {name: msg}, generatedAt}."""
from __future__ import annotations

import json as _json
import time as _time

import asyncio
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import bridge, calendar_google, config, email_himalaya, sessions_store
from ..research import _agent_turn
from . import recommend, settings, state
from .sources import asana, calendar, documents_stale, entities, gmail, obsidian, slack

router = APIRouter()

SOURCES = {
    "gmail": gmail.fetch,
    "slack": slack.fetch,
    "asana": asana.fetch,
    "obsidian": obsidian.fetch,
    "documents": documents_stale.fetch,
    "calendar": calendar.fetch,
    "entities": entities.fetch,
}

# Per-source cache: (ts_ms, items). Cleared by actions on that source.
# Must outlive the frontend's 120s unread-dot poll or every poll re-runs the
# collectors (the dot only diffs ids — staleness is invisible there).
_cache: dict[str, tuple[float, list]] = {}
CACHE_TTL_MS = 150_000


async def _fetch_source(name: str) -> list[dict]:
    now = time.time() * 1000
    hit = _cache.get(name)
    if hit and now - hit[0] < CACHE_TTL_MS:
        return hit[1]
    items = await SOURCES[name]()
    _cache[name] = (now, items)
    return items


@router.get("/api/inbox/slack/thread")
async def slack_thread(channel_id: str, thread_ts: str):
    """Read a slack thread in place (B2). Read-only via conversations_replies."""
    try:
        messages = await slack.fetch_thread(channel_id, thread_ts)
    except Exception as exc:  # noqa: BLE001 — surface offline/timeout to the UI
        return JSONResponse({"error": str(exc)}, status_code=502)
    return {"messages": messages}


@router.get("/api/inbox/asana/task")
async def asana_task(gid: str):
    """Read an asana task + comments in place (B3). Read-only."""
    try:
        return await asana.fetch_task(gid)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=502)


@router.get("/api/items")
async def items(sources: str = "", limit: int = 200):
    enabled = settings.enabled_collectors()
    wanted = [s for s in (sources.split(",") if sources else list(SOURCES))
              if s in SOURCES and s in enabled]
    # Slack staleness guard: kick the refresh job, then serve what we have.
    if "slack" in wanted and slack.signals_stale():
        await slack.kick_refresh()

    async def safe(name: str):
        try:
            return name, await _fetch_source(name), None
        except Exception as exc:  # noqa: BLE001 - per-source isolation
            return name, [], str(exc)

    results = await asyncio.gather(*(safe(n) for n in wanted))
    now_ms = int(time.time() * 1000)
    merged, errors, counts = [], {}, {}
    for name, src_items, err in results:
        if err:
            errors[name] = err
        visible = [i for i in src_items
                   if not state.hidden(i["source"], i["id"], now_ms)]
        counts[name] = len(visible)
        merged.extend(visible)
    stats_snapshot = state.stats()
    ai_recs = state.recs()
    for i in merged:
        rec = recommend.pick(i, stats_snapshot, ai_recs)
        if rec:
            i["rec"] = rec
        else:
            # The dicts live in _cache — clear any rec a previous request
            # attached, or it would outlive the stats/recs that justified it.
            i.pop("rec", None)
    merged.sort(key=lambda i: (-i["score"], i["ageHours"]))
    limit = max(1, min(500, limit))
    return {"items": merged[:limit], "total": len(merged),
            "sources": counts, "errors": errors, "generatedAt": now_ms}


def _bad(msg: str):
    return JSONResponse(status_code=400, content={"ok": False, "error": msg})


def _stat_key(source: str, meta: dict) -> str | None:
    """Counter key for the history-recommendation layer. Single source of
    truth is recommend.counter_key — gmail senders, slack channels, and
    obsidian assignee/meeting-series all learn through the same buckets."""
    return recommend.counter_key({"source": source, "meta": meta})


@router.post("/api/items/action")
async def action(payload: dict):
    source = payload.get("source")
    item_id = str(payload.get("id") or "")
    act = payload.get("action")
    meta = payload.get("meta") or {}
    title = (payload.get("title") or "")[:140]
    if source not in SOURCES or not item_id:
        return _bad("source and id are required")
    undo: dict | None = {"local": True}   # default: undo just restores the card
    try:
        if act == "dismiss":
            state.dismiss(source, item_id)
        elif act == "snooze":
            until = payload.get("until")
            if not isinstance(until, (int, float)) or until <= 0:
                return _bad("snooze requires until (epoch ms)")
            state.snooze(source, item_id, int(until))
        elif act == "reviewed" and source == "obsidian":
            state.dismiss(source, item_id, "reviewed")
        elif act == "archive" and source == "gmail":
            await email_himalaya.move_message(
                item_id, "INBOX", email_himalaya.ARCHIVE_FOLDER)
            state.dismiss(source, item_id, "archived")
            undo = {"folder": email_himalaya.ARCHIVE_FOLDER,
                    "from": meta.get("from") or ""}
        elif act == "delete" and source == "gmail":
            await email_himalaya.move_message(
                item_id, "INBOX", email_himalaya.TRASH_FOLDER)
            state.dismiss(source, item_id, "deleted")
            undo = {"folder": email_himalaya.TRASH_FOLDER,
                    "from": meta.get("from") or ""}
        elif act == "mark_read" and source == "slack":
            await slack.mark_read(item_id, meta.get("channel") or "")
            state.dismiss(source, item_id, "mark_read")
            undo = {"local": True, "note": "restores card only"}
        elif act == "complete" and source == "asana":
            await asana.complete(item_id)
            state.dismiss(source, item_id, "completed")
            undo = {"asana_gid": item_id}
        elif act == "complete" and source == "obsidian":
            # A meeting action item Frank finished himself. No external task to
            # close (those go through add_asana) — just record "done" as its own
            # disposition, distinct from dismiss (noise) and reviewed (FYI), so
            # the learning layer can tell "I act on these" from "I skip these".
            state.dismiss(source, item_id, "completed")
        elif act == "rsvp" and source == "calendar":
            response = payload.get("response")
            event_id = meta.get("event_id") or item_id
            cal = meta.get("calendar") or "primary"
            try:
                await calendar_google.rsvp(event_id, cal, response)
            except ValueError as exc:        # bad response / not an attendee
                return _bad(str(exc))
            state.dismiss(source, item_id, f"rsvp_{response}")
            # Undo restores the pending state by setting responseStatus back to
            # needsAction (the organizer is re-notified via sendUpdates=all).
            undo = {"rsvp_event": event_id, "rsvp_cal": cal}
        elif act == "add_asana":
            from datetime import datetime, timezone
            due = payload.get("due")
            due_on = None
            if isinstance(due, str) and due.strip():
                due_on = due.strip()[:10]
            elif isinstance(due, (int, float)) and due > 0:
                due_on = datetime.fromtimestamp(due / 1000, tz=timezone.utc).date().isoformat()
            task_name = (payload.get("task") or title or "Follow-up")[:140]
            url = meta.get("url") or ""
            notes = (f"Captured from your inbox ({source}).\n\n"
                     f"{(payload.get('snippet') or title or '')[:1000]}\n\n"
                     + (f"Source: {url}" if url else "")).strip()
            gid = await asana.create_task(
                task_name, notes, due_on, settings.asana_section_gid())
            state.dismiss(source, item_id, "added_to_asana")
            undo = {"asana_delete_gid": gid}
        else:
            return _bad(f"unknown action '{act}' for source '{source}'")
    except Exception as exc:  # noqa: BLE001 - surface to the card toast
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": str(exc)})
    skey = _stat_key(source, meta)
    if skey:
        state.bump_stat(skey, act)
    undo_ts = state.log_action(source, item_id, title, act, undo, skey)
    _cache.pop(source, None)
    return {"ok": True, "undoTs": undo_ts}


@router.get("/api/items/history")
async def items_history(limit: int = 20):
    entries = []
    for e in state.history(limit=max(1, min(100, limit))):
        entries.append({**e, "undoable": e["undo"] is not None,
                        "note": (e["undo"] or {}).get("note")})
    return {"entries": entries}


@router.post("/api/items/undo")
async def items_undo(payload: dict):
    ts = payload.get("ts")
    entry = state.pop_history(ts) if isinstance(ts, int) else None
    if entry is None:
        return JSONResponse(status_code=404,
                            content={"ok": False, "error": "no such history entry"})
    undo = entry["undo"]
    if undo is None:
        return _bad("this action is not undoable")
    try:
        if "folder" in undo:                       # gmail archive/delete
            uid = await email_himalaya.find_uid(
                undo["folder"], entry["title"], undo.get("from") or "")
            if not uid:
                raise RuntimeError(
                    f"message not found in {undo['folder']} anymore")
            await email_himalaya.move_message(uid, undo["folder"], "INBOX")
        elif "asana_gid" in undo:                  # asana complete
            await asana.uncomplete(undo["asana_gid"])
        elif "asana_delete_gid" in undo:            # add_asana → delete the task
            await asana.delete_task(undo["asana_delete_gid"])
        elif "rsvp_event" in undo:                  # calendar RSVP → un-respond
            await calendar_google.rsvp(
                undo["rsvp_event"], undo.get("rsvp_cal") or "primary",
                "needsAction")
        # 'local' undo (dismiss/snooze/reviewed/mark_read): nothing remote.
    except Exception as exc:  # noqa: BLE001
        # restore the history entry so the user can retry
        state.log_action(entry["source"], entry["id"], entry["title"],
                         entry["action"], undo, entry.get("statKey"))
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": str(exc)})
    state.undismiss(entry["source"], entry["id"])
    if entry.get("statKey"):
        state.drop_stat(entry["statKey"], entry["action"])
    _cache.pop(entry["source"], None)
    return {"ok": True}


@router.post("/api/items/triage")
async def triage(payload: dict | None = None):
    """One brain turn scores every visible un-scored item (spec §4)."""
    feed = await items(limit=500)
    cached = state.recs()
    pending = [i for i in feed["items"]
               if f"{i['source']}:{i['id']}" not in cached]
    if not pending:
        return {"scored": 0, "skipped": len(feed["items"]), "capHit": False}
    prompt, chosen = recommend.build_triage_prompt(pending)
    try:
        reply = await bridge.run_text(
            prompt, session_key=config.inbox_triage_session_key())
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": str(exc)})
    valid = {i["id"]: i["source"] for i in chosen}
    new = recommend.parse_triage_reply(reply, valid,
                                       now_ms=int(time.time() * 1000))
    if not new:
        return JSONResponse(status_code=503, content={
            "ok": False,
            "error": "triage produced no usable JSON (codex stall/throttle?) "
                     "— nothing cached, try again"})
    live = {f"{i['source']}:{i['id']}" for i in feed["items"]}
    state.set_recs(new, live_keys=live)
    return {"scored": len(new), "skipped": len(feed["items"]) - len(pending),
            "capHit": len(pending) > len(chosen)}


SPINOFF_DEDUPE_MS = 24 * 3600 * 1000


def _log_spinoff(request, item, session_id, deduped):
    """Append-only caller trail (.data/spinoff.log) — a runaway client
    created ~100 sessions for one item before anyone noticed; the UA/IP
    line is how the next one gets identified in minutes, not days."""
    try:
        rec = {"ts": int(_time.time() * 1000), "item_id": item.get("id"),
               "session_id": session_id, "deduped": deduped,
               "client": getattr(getattr(request, "client", None), "host", None),
               "ua": (request.headers.get("user-agent", "")[:160]
                      if request is not None else None)}
        with open(config.DATA_DIR / "spinoff.log", "a") as f:
            f.write(_json.dumps(rec) + "\n")
    except Exception:  # noqa: BLE001 - diagnostics must never break the route
        pass


@router.post("/api/items/spinoff")
async def spinoff(payload: dict, request: Request = None):
    """'Hand to Gary': mint a chat session seeded with the item (the client
    sends the rendered card fields). Same awaited-seed pattern as
    research.spinoff.

    Bulk path: when payload has ``items`` (a non-empty list), one session is
    created and seeded with the whole list; returns {session_id, count}.
    Single-item path is unchanged."""
    items = payload.get("items")
    if isinstance(items, list) and items:
        titles = [(it.get("title") or "").strip() for it in items
                  if (it.get("title") or "").strip()]
        if not titles:
            return _bad("items require titles")
        lines = "\n".join(
            f"- {it.get('title', '(no subject)')} — {it.get('subtitle', '')}"
            for it in items
        )
        seed = (
            "Context — a batch of emails I handed you from my inbox. Help me work "
            "through them (summaries, drafts, or actions as I ask):\n\n"
            f"{lines}\n\nReply with one short sentence confirming you have the list; "
            "I'll say what to do next."
        )
        sess_name = f"Emails: {len(items)} items — {titles[0][:32]}"
        now_ms = int(_time.time() * 1000)
        for existing in sessions_store.list_sessions():
            if existing.get("name") == sess_name and not existing.get("archived") \
                    and now_ms - (existing.get("created") or 0) < SPINOFF_DEDUPE_MS:
                _log_spinoff(request, {"id": "bulk", "title": sess_name},
                             existing["id"], deduped=True)
                return {"session_id": existing["id"], "count": len(items), "deduped": True}
        sess = sessions_store.create(name=sess_name, origin="inbox")
        try:
            await asyncio.wait_for(_agent_turn(seed, sess["sessionKey"], None),
                                   timeout=120)
        except Exception as exc:  # noqa: BLE001
            sessions_store.delete(sess["id"])
            return JSONResponse(status_code=502,
                                content={"detail": f"could not seed the chat: {exc}"})
        _log_spinoff(request, {"id": "bulk", "title": sess_name}, sess["id"],
                     deduped=False)
        return {"session_id": sess["id"], "count": len(items)}

    item = payload.get("item") or {}
    title = (item.get("title") or "").strip()
    if not title:
        return _bad("item.title is required")
    intent = payload.get("intent")
    meta = item.get("meta") or {}
    if intent == "reply" and item.get("source") == "gmail" and meta.get("uid"):
        body_text = ""
        try:
            msg = await email_himalaya.email_read(str(meta["uid"]),
                                                  mark_seen=False)
            body_text = (msg.get("body") or "")[:4000]
        except Exception:  # noqa: BLE001 - draft without the body if read fails
            pass
        style = email_himalaya._load_style()
        style_block = f"\n\nWrite in MY style:\n{style}" if style else ""
        seed = ("Draft a reply to this email. Show me the draft and iterate "
                "with me; I'll send it from the Email tab when happy."
                f"{style_block}\n\nFrom: {item.get('subtitle', '')}\n"
                f"Subject: {title}\n\n{body_text}")
        sess_name = f"Reply: {title[:44]}"
    else:
        seed = ("Context for this conversation — an item from my unified inbox "
                f"({item.get('source', '?')}):\n\nTitle: {title}\n"
                f"From/where: {item.get('subtitle', '')}\n"
                f"Details: {item.get('snippet', '')}\n"
                f"Link: {meta.get('url') or 'n/a'}\n\n"
                "Reply with one short sentence confirming you have the context; "
                "the user will say what they need next.")
        sess_name = f"Inbox: {title[:48]}"
    # One thread per item per day: repeat spinoffs return the existing
    # session instead of minting + re-seeding another (each seed costs a
    # full agent turn — the runaway-client incident burned ~100 of them).
    now_ms = int(_time.time() * 1000)
    for existing in sessions_store.list_sessions():
        if existing.get("name") == sess_name and not existing.get("archived") \
                and now_ms - (existing.get("created") or 0) < SPINOFF_DEDUPE_MS:
            _log_spinoff(request, item, existing["id"], deduped=True)
            return {"session_id": existing["id"], "deduped": True}

    sess = sessions_store.create(name=sess_name, origin="inbox")
    try:
        await asyncio.wait_for(_agent_turn(seed, sess["sessionKey"], None),
                               timeout=120)
    except Exception as exc:  # noqa: BLE001
        sessions_store.delete(sess["id"])
        return JSONResponse(status_code=502,
                            content={"detail": f"could not seed the chat: {exc}"})
    _log_spinoff(request, item, sess["id"], deduped=False)
    return {"session_id": sess["id"]}
