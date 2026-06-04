"""Inbox: serve the triage-dashboard unified feed THROUGH the Odysseus email UI.

The reused Odysseus frontend's inbox is a full IMAP-email client: it calls
`/api/email/list`, `/api/email/folders`, `/api/email/read/{uid}`, and mutation
endpoints (archive/delete/mark-read). It is NOT a generic feed renderer.

The triage-dashboard (OpenClaw workspace/triage-dashboard, :3456) already
aggregates gmail + slack + asana + granola/obsidian into one scored feed at
`GET /api/items`, where each item is:

    { id, source, title, subtitle, snippet, ts, ageHours, score, meta:{url,...} }

So rather than rewrite the (polished) email UI, we ADAPT: every `/api/email/*`
call the UI makes is mapped onto the triage feed. The unified feed renders
through the existing inbox with zero frontend edits — each item's `source`
becomes a tag pill (Gmail / Slack / Asana / Obsidian), so it reads as one inbox.

`uid` is base64url("<source>:<id>") so it survives URL paths / CSS selectors
regardless of what the source id contains, and round-trips back to the right
source for read + actions.

The bare `/api/items` proxy is kept too (handy for debugging / future tabs).
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import config

router = APIRouter()

# Friendly folder labels. Value sent back as ?folder= is the display string;
# folderDisplayName() in the UI leaves non-mail names untouched, so "Gmail"
# shows as "Gmail". INBOX (special-cased by the UI) means "all sources".
_SOURCE_LABELS = {
    "gmail": "Gmail",
    "slack": "Slack",
    "asana": "Asana",
    "obsidian": "Obsidian",
}

# Short-lived cache of the last feed mapped by uid, so /read/{uid} can resolve a
# row without re-fetching (and still works if the feed shifted between calls).
_item_by_uid: dict[str, dict] = {}


def _encode_uid(source: str, item_id: str) -> str:
    raw = f"{source}:{item_id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_uid(uid: str) -> tuple[str, str]:
    pad = "=" * (-len(uid) % 4)
    raw = base64.urlsafe_b64decode(uid + pad).decode()
    source, _, item_id = raw.partition(":")
    return source, item_id


def _iso(ts) -> str:
    try:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()
    except Exception:  # noqa: BLE001
        return ""


def _to_email(item: dict) -> dict:
    """Map one triage item onto the email object shape the inbox UI renders."""
    source = item.get("source", "")
    uid = _encode_uid(source, str(item.get("id", "")))
    subtitle = item.get("subtitle") or _SOURCE_LABELS.get(source, source)
    return {
        "uid": uid,
        "subject": item.get("title") or "(no title)",
        "from_name": subtitle,
        "from_address": subtitle,
        "sender": subtitle,
        "snippet": item.get("snippet") or "",
        "date": _iso(item.get("ts")),
        # Triage items are, by definition, things still needing attention.
        "is_read": False,
        "is_answered": False,
        "is_spam_verdict": False,
        "has_attachments": False,
        # The source renders as a colored tag pill on each row → unified-feed look.
        "tags": [source] if source else [],
        # Carried for the read view / "open original" link (not used by the list).
        "_source": source,
        "_url": (item.get("meta") or {}).get("url", ""),
        "_score": item.get("score"),
    }


async def _fetch_feed(params: dict | None = None) -> dict:
    """Fetch the unified triage feed. Raises on transport failure (caller maps)."""
    url = f"{config.TRIAGE_URL}/api/items"
    # Cold source fetches (gmail/slack live API calls) can take ~20s before the
    # triage server's per-source caches warm; be patient so the first inbox
    # load doesn't falsely render "unreachable".
    async with httpx.AsyncClient(timeout=40) as client:
        resp = await client.get(url, params=params or {"limit": 500})
    resp.raise_for_status()
    return resp.json()


async def _mapped_emails() -> tuple[list[dict], dict]:
    """Return (emails, raw_feed). Refreshes the uid cache as a side effect."""
    feed = await _fetch_feed()
    emails = [_to_email(it) for it in feed.get("items", [])]
    for em in emails:
        _item_by_uid[em["uid"]] = em
    return emails, feed


# --- List: the unified feed, email-shaped ------------------------------------

@router.get("/api/email/list")
async def email_list(request: Request, folder: str = "INBOX",
                     limit: int = 50, offset: int = 0):
    try:
        emails, _feed = await _mapped_emails()
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"emails": [], "total": 0,
             "error": f"inbox feed unreachable: {exc!r}"})

    # Folder filter: INBOX = everything; otherwise match the source label.
    f = (folder or "INBOX").strip().lower()
    if f and f != "inbox":
        emails = [e for e in emails if e["_source"] == f]

    # Sender filter (frontend's "from <addr>" chip): substring on the subtitle.
    sender = (request.query_params.get("from") or "").strip().lower()
    if sender:
        emails = [e for e in emails if sender in (e["from_address"] or "").lower()]

    total = len(emails)
    page = emails[offset:offset + max(1, limit)]
    return {"emails": page, "total": total}


@router.get("/api/email/folders")
async def email_folders():
    """INBOX plus one pseudo-folder per source actually present in the feed."""
    try:
        _emails, feed = await _mapped_emails()
        present = [s for s in feed.get("sources", {}) if feed["sources"][s]]
    except Exception:  # noqa: BLE001
        present = list(_SOURCE_LABELS)
    folders = ["INBOX"] + [_SOURCE_LABELS.get(s, s.title())
                           for s in present if s in _SOURCE_LABELS]
    return {"folders": folders}


@router.get("/api/email/read/{uid}")
async def email_read(uid: str):
    em = _item_by_uid.get(uid)
    if em is None:
        # Cache miss (server restarted / feed shifted): rebuild and retry once.
        try:
            await _mapped_emails()
        except Exception:  # noqa: BLE001
            pass
        em = _item_by_uid.get(uid)
    if em is None:
        return JSONResponse({"error": "item no longer in feed"})

    label = _SOURCE_LABELS.get(em["_source"], em["_source"] or "source")
    url = em.get("_url") or ""
    open_link = (f'<p style="margin-top:14px;"><a href="{url}" target="_blank" '
                 f'rel="noopener">Open original in {label} ↗</a></p>') if url else ""
    body_html = (f'<div style="white-space:pre-wrap;">{em["snippet"] or ""}</div>'
                 f'{open_link}')
    return {
        "subject": em["subject"],
        "from_address": em["from_address"],
        "from_name": em["from_name"],
        "date": em["date"],
        "body": body_html,
        "body_html": body_html,
        "snippet": em["snippet"],
        "message_id": "",
        "references": "",
        "attachments": [],
        "url": url,
    }


# --- Mutations: map onto the triage per-source action endpoints ---------------

async def _source_action(uid: str, action: str) -> dict:
    """POST a triage action for the item behind `uid`. Best-effort."""
    try:
        source, item_id = _decode_uid(uid)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"bad uid: {exc!r}"}
    _item_by_uid.pop(uid, None)  # optimistic: drop from local cache immediately
    url = f"{config.TRIAGE_URL}/api/items/{source}/{item_id}/action"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(url, json={"action": action})
        return {"ok": resp.status_code < 400, "source": source, "action": action}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{exc!r}"}


# Archive + Delete both mean "I've dealt with this — remove it from my inbox".
# `dismiss` is supported by every source and recorded in dismissed.js, so the
# item never resurfaces in /api/items. (Exactly the unified-inbox semantics.)
@router.post("/api/email/archive/{uid}")
async def email_archive(uid: str):
    return await _source_action(uid, "dismiss")


@router.delete("/api/email/delete/{uid}")
async def email_delete(uid: str):
    return await _source_action(uid, "dismiss")


# Read/answered state isn't a triage concept; ack so the UI's optimistic
# updates stick without erroring. (mark_read is forwarded where it's cheap.)
@router.post("/api/email/mark-read/{uid}")
async def email_mark_read(uid: str):
    await _source_action(uid, "mark_read")
    return {"ok": True}


@router.post("/api/email/mark-answered/{uid}")
async def email_mark_answered(uid: str):
    return {"ok": True}


@router.post("/api/email/clear-answered/{uid}")
async def email_clear_answered(uid: str):
    return {"ok": True}


@router.post("/api/email/{uid}/unflag-spam")
async def email_unflag_spam(uid: str):
    return {"ok": True}


@router.get("/api/email/urgency-state")
async def email_urgency_state():
    # No external urgency scanner in this deployment; empty map = no overrides.
    return {"per_uid": {}}


# --- Raw passthrough (debugging / future tabs) -------------------------------

@router.get("/api/items")
async def items(request: Request):
    """Proxy the unified triage feed, passing query params through unchanged."""
    try:
        data = await _fetch_feed(dict(request.query_params) or None)
        return JSONResponse(content=data)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=502,
            content={"items": [], "total": 0,
                     "error": f"triage feed unreachable: {exc!r}"})
