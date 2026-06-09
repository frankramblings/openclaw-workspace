"""Slack mentions/unreads from the slack-refresh snapshot.

The launchd job `ai.openclaw.slack-refresh` (independent of the dead triage
dashboard) writes `~/.openclaw/workspace/tmp/slack_recent_signals.json` with
CSV blobs (`unreads_raw`, `mentions_raw`). We parse those; if the snapshot is
stale we kick the refresh job (non-blocking) and still serve the stale rows.
Only `mark_read` talks to Slack directly — conversations.mark with the
browser-session tokens in the login keychain (xoxc token + xoxd cookie)."""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path

import httpx

from ... import config

SIGNALS_PATH = Path(os.environ.get(
    "INBOX_SLACK_SIGNALS",
    str(config.OPENCLAW_HOME / "workspace/tmp/slack_recent_signals.json")))
CHANNELS_CACHE = Path(os.environ.get(
    "INBOX_SLACK_CHANNELS",
    str(config.OPENCLAW_HOME / "workspace/var/slack-channels.cache.json")))
USERS_CACHE = Path(os.environ.get(
    "INBOX_SLACK_USERS",
    str(config.OPENCLAW_HOME / "workspace/var/slack-users.cache.json")))
SLACK_DOMAIN = os.environ.get("SLACK_DOMAIN", "example.slack.com")
STALE_MIN = int(os.environ.get("SLACK_STALE_MIN", str(24 * 60)))
REFRESH_JOB = "ai.openclaw.slack-refresh"

# Row: TS,UserID,userName,RealName,Channel,ThreadTs,Text...,ISO time,reactions,
_ROW_RE = re.compile(
    r"(\d{10}\.\d{3,7}),(U[A-Z0-9]+),([^,]*),([^,]*),([^,]*),([^,]*),"
    r"([\s\S]*?),(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z),([^,]*),")


def parse_csv_lines(blob: str | None) -> list[dict]:
    out = []
    for m in _ROW_RE.finditer(blob or ""):
        msg_id, user_id, user, real, channel, thread_ts, raw_text, iso, _ = m.groups()
        text = raw_text
        if text.startswith('"') and text.endswith('"'):
            text = text[1:-1].replace('""', '"')
        text = re.sub(r"'\s*\+\s*\n?\s*'", "", text)
        text = text.replace("\\n", "\n").replace("\\'", "'").strip()
        out.append({"msgId": msg_id, "userId": user_id, "userName": user,
                    "realName": real, "channel": channel,
                    "threadTs": thread_ts or None, "text": text,
                    "time": int(time.mktime(
                        time.strptime(iso, "%Y-%m-%dT%H:%M:%SZ")) * 1000)})
    return out


# --- name resolution (#5): turn bare `U…` ids into @display names ---------
# Slack's de-tokenized CSV text carries raw user ids (`U3B6KNK8B`) instead of
# the rendered `@Chris B`; the search tool also returns canonical `<@U…>` /
# `<@U…|label>` tokens. Resolve both against the on-disk users cache.

_ANGLE_USER_RE = re.compile(r"<@(U[A-Z0-9]+)(?:\|([^>]+))?>")
# Leading boundary only (no trailing \b): the Slack MCP renders mentions as the
# id glued straight onto the display name ("U01GEK1BJ8KFrank"), so we can't rely
# on a word boundary after the id.
_BARE_USER_RE = re.compile(r"\bU[A-Z0-9]{6,}")
_USER_MAP_CACHE: dict | None = None


def build_user_map(users: list[dict]) -> dict:
    """id -> best display name (display_name > real_name > name)."""
    out: dict[str, str] = {}
    for u in users:
        uid = u.get("id")
        if not uid:
            continue
        prof = u.get("profile") or {}
        out[uid] = (prof.get("display_name") or u.get("real_name")
                    or prof.get("real_name") or u.get("name") or uid)
    return out


def resolve_slack_refs(text: str | None, user_map: dict) -> str | None:
    """Replace `<@U…>` / `<@U…|label>` / bare `U…` user refs with `@name`.

    Unknown ids (not in the map, no explicit label) are left untouched so we
    never invent a fake handle for an id we can't resolve."""
    if not text:
        return text

    def _angle(m: "re.Match") -> str:
        uid, label = m.group(1), m.group(2)
        if label:
            return "@" + label
        name = user_map.get(uid)
        return "@" + name if name else m.group(0)

    def _bare(m: "re.Match") -> str:
        cand = m.group(0)
        # Standalone id (greedy match stopped at a non-id char): swap in the name.
        if cand in user_map:
            return "@" + user_map[cand]
        # Glued "<id><DisplayName>": the greedy match ate the id plus the name's
        # first (capital) letter. Strip the longest known-id prefix and keep the
        # name the server already appended -> "U01GEK1BJ8KFrank" => "@" + "Frank".
        for length in range(len(cand) - 1, 6, -1):
            if cand[:length] in user_map:
                return "@" + cand[length:]
        return cand

    return _BARE_USER_RE.sub(_bare, _ANGLE_USER_RE.sub(_angle, text))


def _user_map() -> dict:
    """Lazily load + cache the on-disk Slack users cache as an id->name map."""
    global _USER_MAP_CACHE
    if _USER_MAP_CACHE is None:
        try:
            users = json.loads(USERS_CACHE.read_text())
        except (OSError, json.JSONDecodeError):
            users = []
        _USER_MAP_CACHE = build_user_map(users if isinstance(users, list) else [])
    return _USER_MAP_CACHE


def is_low_signal(msg: dict) -> bool:
    text = msg.get("text") or ""
    if msg.get("userName") == "asana":
        return True
    if re.fullmatch(r"(:[a-z0-9_-]+:\s*)+", text):
        return True
    if len(text) < 4:
        return True
    return bool(re.fullmatch(r"https?:\S+\s*-\s*https?:\S+", text.strip()))


def is_dm(channel: str) -> bool:
    """Direct/group DM (Slack ids start with D; group DMs render as @handle)."""
    return (channel or "").startswith(("D", "@"))


def is_signal(msg: dict) -> bool:
    """Slice C: keep only signal — direct @mentions (incl. the mentions feed) and
    DMs. Drops the unread firehose (channel messages where I'm not addressed).
    NOTE: @here/@channel and usergroup mentions are NOT distinguishable here
    (the text is de-tokenized); usergroups + replied-in threads arrive as their
    own feeds in later C slices."""
    return msg.get("kind") == "mention" or is_dm(msg.get("channel", ""))


def map_items(unreads: list[dict], mentions: list[dict],
              handle_map: dict, now_ms: int,
              user_map: dict | None = None) -> list[dict]:
    user_map = user_map or {}
    seen: dict[str, dict] = {}
    for m in unreads:
        seen[m["msgId"]] = {**m, "kind": "unread"}
    for m in mentions:
        seen[m["msgId"]] = {**seen.get(m["msgId"], m), "kind": "mention"}
    items = []
    for m in seen.values():
        if is_low_signal(m) or not is_signal(m):
            continue
        age_h = max(0.0, (now_ms - m["time"]) / 3600_000)
        score = 5 if m["kind"] == "mention" else 2
        if age_h < 2:
            score += 2
        elif age_h < 12:
            score += 1
        if m["channel"].startswith(("D", "@")):
            score += 1
        cid = handle_map.get(m["channel"])
        ts_compact = m["msgId"].replace(".", "")
        url = (f"https://{SLACK_DOMAIN}/archives/{cid}/p{ts_compact}"
               + (f"?thread_ts={m['threadTs']}&cid={cid}" if m["threadTs"] else "")
               ) if cid else None
        items.append({
            "id": m["msgId"], "source": "slack",
            "title": (resolve_slack_refs(m["text"], user_map) or "")[:200],
            "subtitle": f"{m['realName'] or m['userName']} · {m['channel']}"
                        + (" · @mention" if m["kind"] == "mention" else ""),
            "snippet": m["kind"], "ts": m["time"], "ageHours": age_h,
            "score": score,
            "meta": {"channel": m["channel"], "channelId": cid,
                     "threadTs": m["threadTs"], "kind": m["kind"], "url": url},
            "actions": ["mark_read", "dismiss", "snooze"],
        })
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items


def _handle_map() -> dict:
    try:
        chans = json.loads(CHANNELS_CACHE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    out = {}
    for c in chans:
        n, cid = c.get("name"), c.get("id")
        if n and cid:
            out[n] = cid
            if n.startswith("@"):
                out["#" + n[1:]] = cid
            elif n.startswith("#"):
                out["@" + n[1:]] = cid
    return out


def signals_stale() -> bool:
    try:
        age_min = (time.time() - SIGNALS_PATH.stat().st_mtime) / 60
        return age_min > STALE_MIN
    except OSError:
        return True


def kick_refresh() -> None:
    """Fire-and-forget kick of the slack-refresh launchd job."""
    subprocess.Popen(
        ["launchctl", "kickstart", f"gui/{os.getuid()}/{REFRESH_JOB}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def fetch() -> list[dict]:
    raw = json.loads(SIGNALS_PATH.read_text())  # OSError/JSONDecodeError -> errors{}
    unreads = parse_csv_lines(raw.get("unreads_raw"))
    mentions = parse_csv_lines(raw.get("mentions_raw"))
    if not unreads and not mentions and raw.get("unreads_raw") in (None, "null"):
        raise RuntimeError(
            "slack signals empty (refresh produced no rows — check keychain "
            f"access; try: launchctl kickstart -k gui/$UID/{REFRESH_JOB})")
    return map_items(unreads, mentions, _handle_map(),
                     now_ms=int(time.time() * 1000), user_map=_user_map())


# --- thread reader (B2): read a full slack thread in place -------------------
# Use the Slack web API directly (xoxc token + xoxd cookie from the Keychain),
# the same fast path mark_read already uses — NOT mcporter, whose per-call
# slackmcp cold start (~45s+) is far too slow for an interactive tap-to-read.

def map_thread_messages(messages: list[dict], user_map: dict) -> list[dict]:
    """Map conversations.replies message dicts into oldest-first reader rows
    with @names resolved. Skips system/join/bot-subtype noise."""
    out = []
    for m in messages:
        if m.get("subtype"):                 # joins, channel topics, etc.
            continue
        uid = m.get("user") or ""
        out.append({
            "ts": m.get("ts", ""),
            "user": user_map.get(uid) or m.get("username") or uid or "?",
            "text": resolve_slack_refs(m.get("text") or "", user_map),
            "time": int(float(m["ts"]) * 1000) if m.get("ts") else 0,
        })
    out.sort(key=lambda x: x["time"])
    return out


async def fetch_thread(channel_id: str, thread_ts: str, limit: int = 50) -> list[dict]:
    """Read a thread via Slack's conversations.replies. Needs the Keychain
    tokens (readable from the workspace LaunchAgent's GUI session)."""
    if not channel_id or not thread_ts:
        raise RuntimeError("channel_id and thread_ts are required")
    xoxc, xoxd = await asyncio.gather(
        asyncio.to_thread(_keychain, "openclaw.slack.xoxc"),
        asyncio.to_thread(_keychain, "openclaw.slack.xoxd"))
    if not xoxc or not xoxd:
        raise RuntimeError("slack tokens unavailable (keychain locked?)")
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            f"https://{SLACK_DOMAIN}/api/conversations.replies",
            headers={"Cookie": f"d={xoxd}",
                     "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
                                   "AppleWebKit/605.1.15"},
            data={"token": xoxc, "channel": channel_id, "ts": thread_ts,
                  "limit": limit})
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"slack: {data.get('error') or 'unknown'}")
    return map_thread_messages(data.get("messages") or [], _user_map())


def _keychain(service: str) -> str | None:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-a", "frank",
             "-s", service, "-w"],
            capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or None
    except (subprocess.SubprocessError, OSError):
        return None


async def mark_read(msg_id: str, channel_handle: str) -> None:
    cid = _handle_map().get(channel_handle)
    if not cid:
        raise RuntimeError(f"no channel id for {channel_handle}")
    xoxc, xoxd = await asyncio.gather(
        asyncio.to_thread(_keychain, "openclaw.slack.xoxc"),
        asyncio.to_thread(_keychain, "openclaw.slack.xoxd"))
    if not xoxc or not xoxd:
        raise RuntimeError("slack tokens unavailable (keychain)")
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"https://{SLACK_DOMAIN}/api/conversations.mark",
            headers={"Cookie": f"d={xoxd}",
                     "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
                                   "AppleWebKit/605.1.15"},
            data={"token": xoxc, "channel": cid, "ts": msg_id})
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"slack: {data.get('error') or 'unknown'}")
