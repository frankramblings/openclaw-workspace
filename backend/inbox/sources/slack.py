"""Slack mentions/unreads from the slack-refresh snapshot.

The launchd job `ai.openclaw.slack-refresh` (independent of the dead triage
dashboard) writes `~/.openclaw/workspace/tmp/slack_recent_signals.json` with
CSV blobs (`unreads_raw`, `mentions_raw`). We parse those; if the snapshot is
stale we kick the refresh job (non-blocking) and still serve the stale rows.
Only `mark_read` talks to Slack directly — conversations.mark with the
browser-session tokens in the login keychain (xoxc token + xoxd cookie)."""
from __future__ import annotations

import asyncio
import getpass
import json
import os
import re
import subprocess
import time
from pathlib import Path

import httpx

from ... import config
from .. import settings as _inbox_settings

SIGNALS_PATH = Path(os.environ.get(
    "INBOX_SLACK_SIGNALS",
    str(config.OPENCLAW_HOME / "workspace/tmp/slack_recent_signals.json")))
CHANNELS_CACHE = Path(os.environ.get(
    "INBOX_SLACK_CHANNELS",
    str(config.OPENCLAW_HOME / "workspace/var/slack-channels.cache.json")))
USERS_CACHE = Path(os.environ.get(
    "INBOX_SLACK_USERS",
    str(config.OPENCLAW_HOME / "workspace/var/slack-users.cache.json")))
# SLACK_DOMAIN resolved via settings at call time (env SLACK_DOMAIN still wins).
# The module-level constant is kept for backward-compat with tests that mock it;
# code that produces URLs calls _slack_domain() so inbox.json takes effect.
SLACK_DOMAIN = os.environ.get("SLACK_DOMAIN", "example.slack.com")


def _slack_domain() -> str:
    return _inbox_settings.slack_domain()
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


def _mentions_my_group(text: str | None, my_groups: set[str] | None) -> bool:
    """True if the (de-tokenized) text @-mentions a usergroup I belong to.
    Usergroup mentions render as '@Group Name' / '@handle'; we match either."""
    if not my_groups:
        return False
    low = (text or "").lower()
    return any(("@" + g) in low for g in my_groups)


def is_signal(msg: dict, my_groups: set[str] | None = None) -> bool:
    """Slice C: keep only signal — direct @mentions (the mentions feed), DMs, and
    @-mentions of a usergroup I'm in (C2). Drops the rest of the unread firehose.
    NOTE: @here/@channel are NOT distinguishable (text is de-tokenized)."""
    return (msg.get("kind") == "mention"
            or is_dm(msg.get("channel", ""))
            or _mentions_my_group(msg.get("text"), my_groups))


def map_items(unreads: list[dict], mentions: list[dict],
              handle_map: dict, now_ms: int,
              user_map: dict | None = None,
              my_groups: set[str] | None = None) -> list[dict]:
    user_map = user_map or {}
    seen: dict[str, dict] = {}
    for m in unreads:
        seen[m["msgId"]] = {**m, "kind": "unread"}
    for m in mentions:
        seen[m["msgId"]] = {**seen.get(m["msgId"], m), "kind": "mention"}
    items = []
    for m in seen.values():
        if is_low_signal(m) or not is_signal(m, my_groups):
            continue
        kind = m["kind"]
        if (kind == "unread" and not is_dm(m["channel"])
                and _mentions_my_group(m["text"], my_groups)):
            kind = "usergroup"          # @-mention of a group I'm in
        age_h = max(0.0, (now_ms - m["time"]) / 3600_000)
        score = 5 if kind in ("mention", "usergroup") else 2
        if age_h < 2:
            score += 2
        elif age_h < 12:
            score += 1
        if m["channel"].startswith(("D", "@")):
            score += 1
        cid = handle_map.get(m["channel"])
        ts_compact = m["msgId"].replace(".", "")
        url = (f"https://{_slack_domain()}/archives/{cid}/p{ts_compact}"
               + (f"?thread_ts={m['threadTs']}&cid={cid}" if m["threadTs"] else "")
               ) if cid else None
        label = {"mention": " · @mention", "usergroup": " · @group"}.get(kind, "")
        items.append({
            "id": m["msgId"], "source": "slack",
            "title": (resolve_slack_refs(m["text"], user_map) or "")[:200],
            "subtitle": f"{m['realName'] or m['userName']} · {m['channel']}" + label,
            "snippet": kind, "ts": m["time"], "ageHours": age_h,
            "score": score,
            "meta": {"channel": m["channel"], "channelId": cid,
                     "threadTs": m["threadTs"], "kind": kind, "url": url},
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


# --- usergroups (C2): which @-groups am I a member of ------------------------
MY_SLACK_UID = os.environ.get("SLACK_USER_ID", "")
USERGROUPS_TTL = 3600           # membership changes rarely
_USERGROUPS_CACHE: tuple[float, set[str]] | None = None


async def fetch_my_usergroups() -> set[str]:
    """Names+handles (lowercased) of the usergroups I belong to, for matching
    '@Group' mentions in channel messages. One cached usergroups.list call."""
    global _USERGROUPS_CACHE
    now = time.time()
    if _USERGROUPS_CACHE and now - _USERGROUPS_CACHE[0] < USERGROUPS_TTL:
        return _USERGROUPS_CACHE[1]
    groups: set[str] = set()
    xoxc, xoxd = await asyncio.gather(
        asyncio.to_thread(_keychain, "openclaw.slack.xoxc"),
        asyncio.to_thread(_keychain, "openclaw.slack.xoxd"))
    if xoxc and xoxd:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.post(
                    f"https://{_slack_domain()}/api/usergroups.list",
                    headers={"Cookie": f"d={xoxd}",
                             "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac "
                                           "OS X 14_0) AppleWebKit/605.1.15"},
                    data={"token": xoxc, "include_users": "true"})
            data = r.json()
            for g in (data.get("usergroups") or []):
                if MY_SLACK_UID in (g.get("users") or []):
                    for key in (g.get("handle"), g.get("name")):
                        if key:
                            groups.add(key.lower())
        except Exception:  # noqa: BLE001 — degrade to mentions+DMs only
            groups = _USERGROUPS_CACHE[1] if _USERGROUPS_CACHE else set()
    _USERGROUPS_CACHE = (now, groups)
    return groups


# --- replied-in threads with new activity (C3) -------------------------------
# Bounded: only threads whose newest reply is recent + not mine, capped. No
# mute/unsubscribe filter exists in the read-only Slack tools, so the recency
# cap is what keeps busy threads from re-flooding the inbox.
THREAD_RECENT_HOURS = int(os.environ.get("SLACK_THREAD_RECENT_HOURS", "4"))
THREAD_SEARCH_LIMIT = 20      # my recent messages to scan for threads
THREAD_CHECK_CAP = 12         # threads to actually fetch replies for
THREAD_RESULT_CAP = 8         # max thread items surfaced
MY_HANDLE = os.environ.get("SLACK_HANDLE", "")
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15")


def _ts_ms(ts: str | None) -> int:
    try:
        return int(float(ts) * 1000)
    except (TypeError, ValueError):
        return 0


_PERMALINK_TTS_RE = re.compile(r"thread_ts=(\d+\.\d+)")


def _thread_ts_from_match(m: dict) -> str:
    """search.messages omits thread_ts from the match body but includes it in the
    permalink for replies. Use it; fall back to the message's own ts (a top-level
    message that may itself be a thread root)."""
    hit = _PERMALINK_TTS_RE.search(m.get("permalink") or "")
    return hit.group(1) if hit else m.get("ts")


def pick_new_reply(replies: list[dict], my_uid: str,
                   recent_cutoff_ms: int) -> dict | None:
    """Return the newest reply iff it's NOT mine, newer than my latest reply in
    the thread, and within the recency window — i.e. genuine new activity on a
    thread I participated in. None otherwise."""
    mine = [r for r in replies if r.get("user") == my_uid]
    if not mine:
        return None
    my_last = max(_ts_ms(r.get("ts")) for r in mine)
    latest = max(replies, key=lambda r: _ts_ms(r.get("ts")))
    lts = _ts_ms(latest.get("ts"))
    if latest.get("user") != my_uid and lts > my_last and lts >= recent_cutoff_ms:
        return latest
    return None


def map_thread_item(channel_id: str, thread_ts: str, reply: dict,
                    user_map: dict, now_ms: int) -> dict:
    ts = reply.get("ts", "")
    t = _ts_ms(ts) or now_ms
    author = user_map.get(reply.get("user") or "") or reply.get("user") or "?"
    ts_compact = ts.replace(".", "")
    url = (f"https://{_slack_domain()}/archives/{channel_id}/p{ts_compact}"
           f"?thread_ts={thread_ts}&cid={channel_id}")
    return {
        "id": ts, "source": "slack",
        "title": (resolve_slack_refs(reply.get("text") or "", user_map) or "")[:200],
        "subtitle": f"{author} · thread reply",
        "snippet": "thread", "ts": t,
        "ageHours": max(0.0, (now_ms - t) / 3600_000), "score": 4,
        "meta": {"channel": "", "channelId": channel_id, "threadTs": thread_ts,
                 "kind": "thread", "url": url},
        "actions": ["mark_read", "dismiss", "snooze"],
    }


async def fetch_my_threads(user_map: dict, now_ms: int,
                           recent_hours: int | None = None) -> list[dict]:
    """Threads I replied in that have recent new activity from someone else."""
    xoxc, xoxd = await asyncio.gather(
        asyncio.to_thread(_keychain, "openclaw.slack.xoxc"),
        asyncio.to_thread(_keychain, "openclaw.slack.xoxd"))
    if not xoxc or not xoxd:
        return []
    headers = {"Cookie": f"d={xoxd}", "User-Agent": _UA}
    cutoff = now_ms - (recent_hours or THREAD_RECENT_HOURS) * 3600_000
    if not MY_HANDLE:
        return []   # no Slack handle configured — skip thread-search
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            sr = await client.post(
                f"https://{_slack_domain()}/api/search.messages", headers=headers,
                data={"token": xoxc, "query": f"from:@{MY_HANDLE}",
                      "count": THREAD_SEARCH_LIMIT, "sort": "timestamp"})
            sdata = sr.json()
            if not sdata.get("ok"):
                return []
            matches = (sdata.get("messages") or {}).get("matches") or []
            threads: dict[tuple[str, str], bool] = {}
            for m in matches:
                cid = (m.get("channel") or {}).get("id")
                tts = _thread_ts_from_match(m)
                if cid and tts:
                    threads.setdefault((cid, tts), True)

            async def _check(cid: str, tts: str):
                try:
                    rr = await client.post(
                        f"https://{_slack_domain()}/api/conversations.replies",
                        headers=headers,
                        data={"token": xoxc, "channel": cid, "ts": tts, "limit": 50})
                    rd = rr.json()
                    if not rd.get("ok"):
                        return None
                    reply = pick_new_reply(rd.get("messages") or [],
                                           MY_SLACK_UID, cutoff)
                    return map_thread_item(cid, tts, reply, user_map, now_ms) \
                        if reply else None
                except Exception:  # noqa: BLE001
                    return None

            results = await asyncio.gather(
                *[_check(c, t) for c, t in list(threads)[:THREAD_CHECK_CAP]])
    except Exception:  # noqa: BLE001 — degrade silently; the mentions feed stands
        return []
    items = [r for r in results if r]
    items.sort(key=lambda i: -i["ts"])
    return items[:THREAD_RESULT_CAP]


def signals_stale() -> bool:
    try:
        age_min = (time.time() - SIGNALS_PATH.stat().st_mtime) / 60
        return age_min > STALE_MIN
    except OSError:
        return True


async def kick_refresh() -> None:
    """Fire-and-forget kick of the slack-refresh launchd job."""
    def _kick() -> None:
        subprocess.Popen(
            ["launchctl", "kickstart", f"gui/{os.getuid()}/{REFRESH_JOB}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    await asyncio.to_thread(_kick)


async def fetch() -> list[dict]:
    raw = json.loads(SIGNALS_PATH.read_text())  # OSError/JSONDecodeError -> errors{}
    unreads = parse_csv_lines(raw.get("unreads_raw"))
    mentions = parse_csv_lines(raw.get("mentions_raw"))
    if not unreads and not mentions and raw.get("unreads_raw") in (None, "null"):
        raise RuntimeError(
            "slack signals empty (refresh produced no rows — check keychain "
            f"access; try: launchctl kickstart -k gui/$UID/{REFRESH_JOB})")
    now_ms = int(time.time() * 1000)
    user_map = _user_map()
    base = map_items(unreads, mentions, _handle_map(), now_ms=now_ms,
                     user_map=user_map, my_groups=await fetch_my_usergroups())
    # C3: add replied-in threads with recent new activity, de-duped by id.
    seen_ids = {i["id"] for i in base}
    base.extend(t for t in await fetch_my_threads(user_map, now_ms)
                if t["id"] not in seen_ids)
    base.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return base


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
            f"https://{_slack_domain()}/api/conversations.replies",
            headers={"Cookie": f"d={xoxd}",
                     "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
                                   "AppleWebKit/605.1.15"},
            data={"token": xoxc, "channel": channel_id, "ts": thread_ts,
                  "limit": limit})
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"slack: {data.get('error') or 'unknown'}")
    return map_thread_messages(data.get("messages") or [], _user_map())


# macOS keychain account holding the Slack browser-session tokens. Defaults to
# the current OS user (the maintainer's was their login name); override with
# SLACK_KEYCHAIN_ACCOUNT for a different keychain account name.
def _keychain_account() -> str:
    return os.environ.get("SLACK_KEYCHAIN_ACCOUNT") or _os_user()


def _os_user() -> str:
    try:
        return getpass.getuser()
    except Exception:  # noqa: BLE001 - getuser can raise if no passwd entry
        return os.environ.get("USER") or os.environ.get("LOGNAME") or ""


def _keychain(service: str) -> str | None:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-a", _keychain_account(),
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
            f"https://{_slack_domain()}/api/conversations.mark",
            headers={"Cookie": f"d={xoxd}",
                     "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
                                   "AppleWebKit/605.1.15"},
            data={"token": xoxc, "channel": cid, "ts": msg_id})
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"slack: {data.get('error') or 'unknown'}")
