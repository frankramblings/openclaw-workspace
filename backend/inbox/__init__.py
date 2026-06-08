"""Unified Inbox: native collectors merged behind /api/items.

Replaces the triage-dashboard proxy (the dashboard was a wedged pre-alpha;
decision + design in docs/superpowers/specs/2026-06-05-native-inbox-design.md).
Each source fetches concurrently with per-source error isolation; local
dismiss/snooze state filters the merge. Response keeps the dashboard's shape:
{items, total, sources: {name: count}, errors: {name: msg}, generatedAt}."""
from __future__ import annotations

import asyncio
import subprocess
import time
from urllib.parse import urlparse

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .. import bridge, config, email_himalaya, sessions_store
from ..research import _agent_turn
from . import recommend, state
from .sources import asana, documents_stale, gmail, obsidian, slack

router = APIRouter()

SOURCES = {
    "gmail": gmail.fetch,
    "slack": slack.fetch,
    "asana": asana.fetch,
    "obsidian": obsidian.fetch,
    "documents": documents_stale.fetch,
}

# Per-source 60s cache: (ts_ms, items). Cleared by actions on that source.
_cache: dict[str, tuple[float, list]] = {}
CACHE_TTL_MS = 60_000


async def _fetch_source(name: str) -> list[dict]:
    now = time.time() * 1000
    hit = _cache.get(name)
    if hit and now - hit[0] < CACHE_TTL_MS:
        return hit[1]
    items = await SOURCES[name]()
    _cache[name] = (now, items)
    return items


def validate_open_url(url: object) -> str:
    """Security boundary for the `open <url>` fallback: only plain http(s) URLs.

    Rejects non-web schemes (file://, javascript:, app paths) and any value
    starting with '-' (which `open` would treat as an option, not a URL)."""
    if not isinstance(url, str):
        raise ValueError("url must be a string")
    url = url.strip()
    if not url or url.startswith("-"):
        raise ValueError("empty or option-like url")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("only http(s) urls are allowed")
    return url


@router.post("/api/items/open")
async def open_external(payload: dict):
    """Open a deep-link in the host's default browser (desktop fallback for the
    PWA, which can't escape its own browser window). The frontend only calls
    this when running on the workspace host itself — see inbox.js."""
    try:
        url = validate_open_url((payload or {}).get("url"))
    except ValueError as exc:
        return JSONResponse({"success": False, "error": str(exc)}, status_code=400)
    try:
        subprocess.run(["open", url], timeout=10)
    except Exception as exc:  # noqa: BLE001 — surface any spawn failure to the UI
        return JSONResponse({"success": False, "error": str(exc)}, status_code=500)
    return {"success": True}


@router.get("/api/items")
async def items(sources: str = "", limit: int = 200):
    wanted = [s for s in (sources.split(",") if sources else list(SOURCES))
              if s in SOURCES]
    # Slack staleness guard: kick the refresh job, then serve what we have.
    if "slack" in wanted and slack.signals_stale():
        slack.kick_refresh()

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
    """Counter key for the history-recommendation layer. Only gmail senders
    and slack channels have a stable 'sender' notion (spec §2)."""
    if source == "gmail" and meta.get("from"):
        return f"gmail:{meta['from'].lower()}"
    if source == "slack" and meta.get("channel"):
        return f"slack:{meta['channel']}"
    return None


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


@router.post("/api/items/spinoff")
async def spinoff(payload: dict):
    """'Hand to Gary': mint a chat session seeded with the item (the client
    sends the rendered card fields). Same awaited-seed pattern as
    research.spinoff."""
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
    sess = sessions_store.create(name=sess_name)
    try:
        await asyncio.wait_for(_agent_turn(seed, sess["sessionKey"], None),
                               timeout=120)
    except Exception as exc:  # noqa: BLE001
        sessions_store.delete(sess["id"])
        return JSONResponse(status_code=502,
                            content={"detail": f"could not seed the chat: {exc}"})
    return {"session_id": sess["id"]}
