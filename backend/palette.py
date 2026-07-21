"""Cross-source lexical search endpoint for the ⌘K palette.

Searches sessions, notes, documents, and email via their existing store APIs.
Returns ranked results (title-prefix > title-substring > content-substring),
tie-broken by recency.

SOURCES AND APIs:
- Sessions: backend.sessions_store.list_sessions() → [dict]
  Fields: id, name, created, updated
- Notes: backend.notes._load_all() → [dict]
  Fields: id, title, content, created, updated, archived
- Documents: backend.documents._load_docs() → [dict]
  Fields: id, title, current_content, created, updated_at, archived
- Email: NOT searched yet. email_himalaya.email_list() is a live proxy over
  himalaya_cli (subprocess -> IMAP/Gmail over the network, see
  backend/himalaya_cli.py's module docstring) with zero local caching
  anywhere in the codebase (confirmed: no email index/cache module exists).
  Calling it from this keystroke-driven endpoint would trigger a live IMAP
  fetch on every debounced query, which the "no network I/O" constraint
  forbids. Until a real local email cache/index exists (future unit),
  _load_email_async() below is a stub that always returns [] — the "email"
  kind is a valid, empty result set for now.

No network I/O; no full-chat-history fetches (sessions match by title only).
Single-user scale — no caching layer needed.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

_log = logging.getLogger(__name__)


# Ranking tiers for relevance scoring
RANK_TITLE_PREFIX = 0
RANK_TITLE_SUBSTR = 1
RANK_CONTENT_SUBSTR = 2


def _num_ts(value: Any) -> int:
    """Coerce a store timestamp to an epoch int for ranking/output. Live
    stores mix int epochs and ISO-8601 strings (deploy smoke caught a string
    `updated` crashing the unary-minus sort at line ~206; test fixtures were
    all ints). Non-parseable → 0: the item ranks last instead of 500ing the
    endpoint."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        # Stores mix units: sessions carry epoch-ms, notes/docs epoch-s.
        # Normalize to seconds so cross-source recency ties compare fairly.
        return int(value // 1000) if value > 10**12 else int(value)
    if isinstance(value, str):
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
        except ValueError:
            return 0
    return 0


def _rank_and_snippet(q: str, kind: str, item: dict) -> tuple[int, str] | None:
    """Compute rank tier and snippet for an item matching query q.

    Returns (rank_tier, snippet) or None if no match.
    """
    q_lower = q.lower()

    # Get the title and content fields based on item kind
    if kind == "session":
        title = item.get("name", "").lower()
        content = ""  # Sessions: title-only matching per brief
    elif kind == "note":
        title = item.get("title", "").lower()
        content = item.get("content", "").lower()
    elif kind == "document":
        title = item.get("title", "").lower()
        content = item.get("current_content", "").lower()
    elif kind == "email":
        title = item.get("subject", "").lower()
        content = item.get("snippet", "").lower()
    else:
        return None

    # Check for title match first (prefix > substring)
    if title.startswith(q_lower):
        return RANK_TITLE_PREFIX, title[:100]
    if q_lower in title:
        return RANK_TITLE_SUBSTR, title[:100]

    # Content match only if content exists
    if content and q_lower in content:
        # Find the match and return ~100 chars centered on it
        idx = content.find(q_lower)
        start = max(0, idx - 40)
        end = min(len(content), idx + 60)
        snippet = content[start:end]
        return RANK_CONTENT_SUBSTR, snippet

    return None


async def search(q: str, limit: int = 20) -> list[dict]:
    """Search across all sources for items matching q.

    Args:
        q: Search query (whitespace/empty → recent sessions only)
        limit: Max results to return (default 20)

    Returns:
        List of result dicts: {kind, id, title, snippet, ts}
        ranked best-first, capped at limit.
    """
    if len(q) > 200:
        raise ValueError("query too long (max 200 chars)")

    results: list[dict] = []
    q_stripped = (q or "").strip()

    # Load all sources in parallel; failures degrade gracefully
    session_items = await asyncio.to_thread(_load_sessions)
    note_items = await asyncio.to_thread(_load_notes)
    doc_items = await asyncio.to_thread(_load_docs)
    email_items = await _load_email_async()

    # Empty query → recent sessions only
    if not q_stripped:
        # Sort sessions by creation time, newest first
        session_items_sorted = sorted(
            session_items,
            key=lambda s: _num_ts(s.get("created", 0)),
            reverse=True
        )[:limit]
        return [
            {
                "kind": "session",
                "id": s["id"],
                "title": s.get("name", ""),
                "snippet": "",
                "ts": _num_ts(s.get("created", 0)),
            }
            for s in session_items_sorted
        ]

    # Search all sources. Each item is matched/built inside its own
    # try/except: a single malformed record (unexpected None field, missing
    # id, etc.) must only drop that one item, never crash the whole source
    # or the whole endpoint (which would otherwise surface as a 500 from the
    # route's outer catch-all). One warning per source is logged, not one
    # per bad item, to avoid log spam on a systemically malformed source.
    for item in session_items:
        try:
            result = _rank_and_snippet(q_stripped, "session", item)
            if result and item.get("id"):
                rank, snippet = result
                results.append({
                    "kind": "session",
                    "id": item["id"],
                    "title": item.get("name", ""),
                    "snippet": snippet,
                    "ts": _num_ts(item.get("created", 0)),
                    "_rank": rank,
                    "_ts": _num_ts(item.get("created", 0)),
                })
        except Exception:
            _log.warning("palette: skipping malformed session item", exc_info=True)

    for item in note_items:
        if item.get("archived"):
            continue
        try:
            result = _rank_and_snippet(q_stripped, "note", item)
            if result and item.get("id"):
                rank, snippet = result
                results.append({
                    "kind": "note",
                    "id": item["id"],
                    "title": item.get("title", ""),
                    "snippet": snippet,
                    "ts": _num_ts(item.get("updated", 0)),
                    "_rank": rank,
                    "_ts": _num_ts(item.get("updated", 0)),
                })
        except Exception:
            _log.warning("palette: skipping malformed note item", exc_info=True)

    for item in doc_items:
        if item.get("archived"):
            continue
        try:
            result = _rank_and_snippet(q_stripped, "document", item)
            if result and item.get("id"):
                rank, snippet = result
                results.append({
                    "kind": "document",
                    "id": item["id"],
                    "title": item.get("title", ""),
                    "snippet": snippet,
                    "ts": _num_ts(item.get("updated_at", 0)),
                    "_rank": rank,
                    "_ts": _num_ts(item.get("updated_at", 0)),
                })
        except Exception:
            _log.warning("palette: skipping malformed document item", exc_info=True)

    for item in email_items:
        try:
            result = _rank_and_snippet(q_stripped, "email", item)
            if result and item.get("uid"):
                rank, snippet = result
                # Parse email date to timestamp (approximate)
                ts = item.get("_ts", 0)
                results.append({
                    "kind": "email",
                    "id": item["uid"],
                    "title": item.get("subject", ""),
                    "snippet": snippet,
                    "ts": ts,
                    "_rank": rank,
                    "_ts": ts,
                })
        except Exception:
            _log.warning("palette: skipping malformed email item", exc_info=True)

    # Sort by rank tier, then by recency descending
    results.sort(key=lambda r: (r["_rank"], -r["_ts"]))

    # Remove internal sort keys and cap at limit
    for r in results:
        del r["_rank"]
        del r["_ts"]

    return results[:limit]


def _load_sessions() -> list[dict]:
    """Load all sessions via sessions_store. Degrade gracefully on error."""
    try:
        from . import sessions_store
        return sessions_store.list_sessions()
    except Exception as e:
        _log.exception("palette: failed to load sessions: %s", e)
        return []


def _load_notes() -> list[dict]:
    """Load all notes via notes module. Degrade gracefully on error."""
    try:
        from . import notes
        # Access the internal _load_all function
        return notes._load_all()
    except Exception as e:
        _log.exception("palette: failed to load notes: %s", e)
        return []


def _load_docs() -> list[dict]:
    """Load all documents. Degrade gracefully on error."""
    try:
        from . import documents
        # Scan documents directory like the documents module does
        if not documents.DOCS_DIR.exists():
            return []
        docs = []
        for p in documents.DOCS_DIR.glob("*.md"):
            try:
                doc = documents._load(p.stem)
                if doc:
                    docs.append(doc)
            except Exception:
                continue
        return docs
    except Exception as e:
        _log.exception("palette: failed to load documents: %s", e)
        return []


async def _load_email_async() -> list[dict]:
    """Email source for the palette — currently always empty.

    email_himalaya.email_list() is a live proxy over himalaya_cli, which
    shells out to the himalaya binary and speaks IMAP to Gmail over the
    network (see backend/himalaya_cli.py). There is no local email
    cache/index anywhere in this codebase, so there is currently no way to
    satisfy "search email" without a network round-trip per keystroke —
    which the palette's no-network-I/O constraint forbids outright. Rather
    than violate that constraint, this source is a documented no-op stub
    until a real local email index exists (tracked as a follow-up; not
    built here per the "no new caching layer" scope of this unit). The
    "email" kind remains valid in the response shape with zero results.
    """
    return []
