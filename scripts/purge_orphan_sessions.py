#!/usr/bin/env python3
"""Delete gateway web-* sessions that no longer have a local chat record.

Chats deleted before the workspace learned to hard-delete (plus finished
research/utility threads) leave transcripts accumulating in the gateway's
session store — real weight on this 8GB box. This sweep lists the gateway's
sessions and deletes (WITH transcript) every `agent:main:web-*` thread that:
  - is not referenced anywhere in .data/*.json (sessions, research jobs, ...),
  - is not a protected utility key, and
  - has been idle for >24h (a live research thread may not be persisted yet).

Dry-run by default:
    .venv/bin/python scripts/purge_orphan_sessions.py
    .venv/bin/python scripts/purge_orphan_sessions.py --apply
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import config               # noqa: E402
from backend.bridge import gateway_call  # noqa: E402

# Never delete these even when unreferenced: the shared web key and the
# utility threads the backend uses on demand.
PROTECTED = {
    config.web_session_key(),
    f"{config.web_session_prefix()}-titler",
    f"{config.web_session_prefix()}-memex",
}

_MIN_AGE_MS = 24 * 3600 * 1000  # don't touch threads active in the last day


def find_orphans(sessions: list, referenced_blob: str, prefix: str,
                 protected: set, now_ms: int,
                 min_age_ms: int = _MIN_AGE_MS) -> list:
    """Pure filter: per-chat web threads (`<prefix>-...`) that nothing
    references, aren't protected, and have been idle past the age guard."""
    orphans = []
    for s in sessions:
        key = (s.get("key") or "") if isinstance(s, dict) else ""
        if not key.startswith(prefix + "-"):
            continue  # not a per-chat web thread (also skips the bare key)
        if key in protected or key in referenced_blob:
            continue
        if (s.get("updatedAt") or 0) > now_ms - min_age_ms:
            continue  # recently active — could be a running research thread
        orphans.append(key)
    return orphans


def _referenced_blob() -> str:
    """Everything in .data/*.json as one searchable string — any file that
    mentions a session key (sessions.json, research stores, ...) keeps it."""
    parts = []
    for f in sorted(config.DATA_DIR.glob("*.json")):
        try:
            parts.append(f.read_text())
        except OSError:
            pass
    return "\n".join(parts)


def blob_looks_valid(referenced_blob: str) -> bool:
    """Guard for --apply: an empty/sessionKey-less blob almost certainly means
    .data was unreadable, and deleting against it would orphan-flag everything.
    Note: if .data/sessions.json legitimately has zero sessions there is nothing
    worth sweeping that a dry-run cannot confirm first — the refusal is correct."""
    return "sessionKey" in referenced_blob


async def main(apply: bool) -> None:
    payload = await gateway_call("sessions.list",
                                 {"limit": 1000, "includeGlobal": True,
                                  "includeUnknown": True})
    sessions = payload.get("sessions") or []
    referenced = _referenced_blob()
    if apply and not blob_looks_valid(referenced):
        print("refusing --apply: .data/*.json yielded no sessionKey references "
              "(unreadable or empty store?) — every idle thread would look "
              "orphaned. Fix .data or run the dry-run to inspect.", file=sys.stderr)
        return
    orphans = find_orphans(sessions, referenced,
                           config.web_session_prefix(), PROTECTED,
                           int(time.time() * 1000))
    print(f"{len(sessions)} gateway sessions, {len(orphans)} orphaned web threads")
    for key in orphans:
        if apply:
            res = await gateway_call("sessions.delete",
                                     {"key": key, "deleteTranscript": True})
            print(f"deleted  {key}  -> {res}")
        else:
            print(f"would delete  {key}")
    if orphans and not apply:
        print("\ndry-run only — re-run with --apply to delete")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="actually delete (default: dry-run)")
    asyncio.run(main(ap.parse_args().apply))
