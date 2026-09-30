"""One-shot: push every workspace thread title into its gateway session label.

New titles sync automatically (backend/gateway_label.py); this catches the
threads that were titled before that existed, plus the workspace's own helper
sessions, so the Control UI / iOS sidebar shows names instead of raw keys.

    PYTHONPATH=. .venv/bin/python scripts/backfill_gateway_labels.py [--dry-run]
"""
from __future__ import annotations

import asyncio
import sys

from backend import bridge, chat_turn, config, gateway_label, sessions_store

HELPERS = {
    "titler": "Workspace: thread titler",
    "memex": "Workspace: memory extractor",
    "suggester": "Workspace: composer suggestions",
}
OTHER = {
    "agent:main:openai-user:siri-frank": "Siri (Frank)",
    "agent:main:openai-user:siri-test": "Siri (test)",
}


async def main(dry: bool) -> None:
    live = await bridge.gateway_call("sessions.list", {"limit": 2000})
    have = {s["key"]: s.get("label") for s in live.get("sessions", [])}

    wanted: list[tuple[str, str]] = []
    prefix = config.web_session_prefix()
    for suffix, label in HELPERS.items():
        wanted.append((f"{prefix}-{suffix}", label))
    wanted.extend(OTHER.items())
    recs = sorted(sessions_store.list_sessions(),
                  key=lambda r: r.get("updated") or 0, reverse=True)
    for r in recs:
        if r.get("sessionKey") and not chat_turn._needs_title(r):
            wanted.append((r["sessionKey"], r["name"]))

    done = skipped = 0
    for key, name in wanted:
        if key not in have or have[key]:
            skipped += 1          # not in gateway, or already labeled
            continue
        if dry:
            print(f"would label {key} -> {name}")
            continue
        applied = await gateway_label.sync(key, name)
        print(f"{'ok ' if applied else 'ERR'} {key} -> {applied or name}")
        done += bool(applied)
    print(f"labeled {done}, skipped {skipped}")


if __name__ == "__main__":
    asyncio.run(main("--dry-run" in sys.argv))
