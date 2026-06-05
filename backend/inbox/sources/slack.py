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
SLACK_DOMAIN = os.environ.get("SLACK_DOMAIN", "wistia.slack.com")
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


def is_low_signal(msg: dict) -> bool:
    text = msg.get("text") or ""
    if msg.get("userName") == "asana":
        return True
    if re.fullmatch(r"(:[a-z0-9_-]+:\s*)+", text):
        return True
    if len(text) < 4:
        return True
    return bool(re.fullmatch(r"https?:\S+\s*-\s*https?:\S+", text.strip()))


def map_items(unreads: list[dict], mentions: list[dict],
              handle_map: dict, now_ms: int) -> list[dict]:
    seen: dict[str, dict] = {}
    for m in unreads:
        seen[m["msgId"]] = {**m, "kind": "unread"}
    for m in mentions:
        seen[m["msgId"]] = {**seen.get(m["msgId"], m), "kind": "mention"}
    items = []
    for m in seen.values():
        if is_low_signal(m):
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
            "title": m["text"][:200],
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
                     now_ms=int(time.time() * 1000))


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
