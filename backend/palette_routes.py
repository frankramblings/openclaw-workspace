"""Routes for the ⌘K palette search endpoint."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from . import palette

_log = logging.getLogger(__name__)
router = APIRouter()


_VALID_KINDS = {"session", "note", "document", "email"}


def _parse_kinds(raw: str) -> set[str] | None:
    """Comma-separated kinds -> a validated set, or None for 'no filter'
    (absent param, or every token unrecognized -- fail open rather than
    return an empty result set for a typo'd kinds value)."""
    if not raw:
        return None
    tokens = {t.strip() for t in raw.split(",") if t.strip()}
    valid = tokens & _VALID_KINDS
    return valid or None


@router.get("/api/palette")
async def palette_search(q: str = Query(""), limit: int = Query(20),
                          kinds: str = Query("")):
    """Search across sessions, notes, documents, and email.

    Args:
        q: Search query (empty → recent sessions only, or recent items of
           `kinds` when given)
        limit: Max results to return (default 20)
        kinds: optional comma-separated subset of session,note,document,email.
            Absent or all-unrecognized -> unchanged (every kind).

    Returns:
        {"results": [{"kind": str, "id": str, "title": str, "snippet": str, "ts": int|null}]}

    Errors:
        400: query too long (>200 chars)
    """
    try:
        if len(q) > 200:
            return JSONResponse(
                {"error": "query too long (max 200 chars)"},
                status_code=400
            )

        results = await palette.search(q, limit=min(limit, 100), kinds=_parse_kinds(kinds))
        return {"results": results}

    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        _log.exception("palette search failed: %s", e)
        return JSONResponse({"error": "search failed"}, status_code=500)
