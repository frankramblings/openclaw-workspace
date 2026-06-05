"""In-chat web search + the settings that drive it.

The Odysseus SPA does web search SERVER-side: the chat composer just posts
`use_web=true` with the message, and the provider/result-count live in the
settings object at /api/auth/settings. Upstream that hit OpenAI tooling; here
we call SerpAPI directly — the key already lives in OpenClaw's config
(`skills.entries.serpapi.apiKey`, the agent's serpapi skill), so there's one
credential for both the agent and the workspace.

Settings persist in .data/settings.json (same tiny-JSON pattern as prefs).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import httpx

from . import config

_SETTINGS_FILE = config.DATA_DIR / "settings.json"

# What the SPA's settings panel can save; everything else is passed through.
DEFAULTS = {
    "search_provider": "serpapi",
    "search_result_count": 5,
}


def _read(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001 - absent/corrupt → fallback
        return fallback


def load_settings() -> dict:
    return {**DEFAULTS, **_read(_SETTINGS_FILE, {})}


def save_settings(patch: dict) -> dict:
    cur = _read(_SETTINGS_FILE, {})
    cur.update(patch or {})
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _SETTINGS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cur, indent=1))
    tmp.replace(_SETTINGS_FILE)  # atomic
    return {**DEFAULTS, **cur}


def serpapi_key() -> str | None:
    """SerpAPI key: env > saved settings > OpenClaw's serpapi skill entry."""
    env = os.environ.get("SERPAPI_API_KEY")
    if env:
        return env
    saved = _read(_SETTINGS_FILE, {}).get("serpapi_api_key")
    if saved:
        return saved
    try:
        entry = config._openclaw_json()["skills"]["entries"]["serpapi"]
        return entry.get("apiKey") or None
    except (KeyError, TypeError):
        return None


async def search(query: str, count: int = 5) -> list[dict]:
    """SerpAPI Google search → [{title, url, snippet}]. Raises on HTTP/auth
    errors; callers decide whether that should break the chat turn (it
    shouldn't — see app.chat_stream)."""
    key = serpapi_key()
    if not key:
        raise RuntimeError("no SerpAPI key configured")
    params = {"engine": "google", "q": query, "num": max(1, min(count, 10)),
              "api_key": key}
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get("https://serpapi.com/search.json", params=params)
        res.raise_for_status()
        data = res.json()
    out = []
    for item in data.get("organic_results") or []:
        if not item.get("link"):
            continue
        out.append({
            "title": item.get("title") or item["link"],
            "url": item["link"],
            "snippet": item.get("snippet") or "",
        })
        if len(out) >= count:
            break
    return out


def context_block(query: str, results: list[dict]) -> str:
    """Format results as a context preamble for the brain turn."""
    lines = [f"[{i+1}] {r['title']}\n    {r['url']}\n    {r['snippet']}"
             for i, r in enumerate(results)]
    joined = "\n".join(lines)
    return (
        "Web search results for the user's message (fetched just now via "
        f"SerpAPI; cite sources as [n] with their URLs when you use them):\n"
        f"{joined}\n\n---\n\nUser message: {query}"
    )
