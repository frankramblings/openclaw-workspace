"""Semantic (embedding-based) search over all chat message CONTENT.

Message content lives in the brain and is read back per-session via
`bridge.fetch_history`. This module builds a local embedding index of that
content in sqlite (`.data/chat_search.db`) and serves cosine-similarity search
over it. Embeddings are computed LOCALLY on the kamino inference node
(ollama `nomic-embed-text`, 768-dim) — chat content never leaves the tailnet.

Design constraints (single user, small scale ~291 sessions):
  * Incremental: a session is re-embedded only when its `updated` stamp moves.
  * Resilient: one session's gateway/embed failure never aborts a full reindex.
  * Graceful degradation: local embed endpoint unreachable → indexing/search are
    no-ops that log a warning and return empty, never raise.
  * Cheap search: the embedding matrix is cached in-process keyed on the db
    file mtime, so repeated queries don't re-read sqlite.

The embed endpoint defaults to kamino's ollama (LAN) and is overridable via
`CHAT_EMBED_URL`. No API key or cloud egress is involved.
"""
from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import sqlite3
import threading
from pathlib import Path

import httpx
import numpy as np

from . import bridge, config, history_display, sessions_store

log = logging.getLogger("workspace.chat_search")

# --- Tunables ----------------------------------------------------------------
_DB_PATH = config.DATA_DIR / "chat_search.db"


# Local embed endpoint (ollama, LAN); override with CHAT_EMBED_URL. A
# function, not a constant, so tests can call it directly and a per-tenant
# host stays current.
def _default_embed_url() -> str:
    return f"http://{config.local_host()}:11434/api/embed"


_EMBED_URL = os.environ.get("CHAT_EMBED_URL", _default_embed_url())
_EMBED_MODEL = os.environ.get("CHAT_EMBED_MODEL", "nomic-embed-text")
# nomic-embed-text is asymmetric: index docs and queries get distinct task
# prefixes for best retrieval quality.
_EMBED_PREFIX = {"document": "search_document: ", "query": "search_query: "}
_MAX_TEXT_CHARS = 1200      # truncate each chunk before embedding
_SNIPPET_CHARS = 240        # content_snippet length in results
_BATCH = 64                 # inputs per local embed request
_MIN_CONTENT_LEN = 12       # skip trivially short messages
# Per-session transcript window. The gateway's chat.history rejects limits
# above ~1000 (returns empty), so 1000 is the effective ceiling — the same cap
# the app's /api/history route uses. Tail-only for very long transcripts.
_HISTORY_LIMIT = 1000

# One reindex at a time.
_reindex_lock = asyncio.Lock()

# In-process cache of the embedding matrix, keyed on the db file mtime so a
# fresh reindex (which rewrites the db) invalidates it. Guarded by a plain lock
# because search() may run concurrently with itself.
_MATRIX_LOCK = threading.Lock()
_matrix_cache: dict = {"mtime": None, "matrix": None, "rows": None}


# --- local embed availability ------------------------------------------------
def _embed_enabled() -> bool:
    """True if the local embed endpoint is reachable. A short probe against the
    ollama host root; failures mean indexing/search degrade to no-ops rather
    than raising. No key or cloud call is involved."""
    try:
        host = _EMBED_URL.rsplit("/api/", 1)[0] or _EMBED_URL
        r = httpx.get(host, timeout=2.0)
        return r.status_code < 500
    except Exception:  # noqa: BLE001 - unreachable == disabled
        return False


async def _embed(texts: list[str], input_type: str) -> list[list[float]] | None:
    """Embed `texts` LOCALLY on kamino (ollama nomic-embed-text) in batches.
    `input_type` is "document" (indexing) or "query" (search), mapped to the
    model's task prefix. Returns a list of float vectors aligned with `texts`,
    or None on a hard failure. Best-effort: on error it logs and returns None so
    callers degrade gracefully. Chat content never leaves the tailnet."""
    prefix = _EMBED_PREFIX.get(input_type, "")
    out: list[list[float]] = []
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            for i in range(0, len(texts), _BATCH):
                batch = [prefix + t for t in texts[i:i + _BATCH]]
                body = {"model": _EMBED_MODEL, "input": batch}
                res = await client.post(_EMBED_URL, json=body)
                if res.status_code != 200:
                    log.warning("chat_search: embed endpoint returned %s (batch %d)",
                                res.status_code, i // _BATCH)
                    return None
                embs = res.json().get("embeddings") or []
                if len(embs) != len(batch):
                    log.warning("chat_search: embed returned %d vectors for %d inputs",
                                len(embs), len(batch))
                    return None
                out.extend(embs)
    except Exception as exc:  # noqa: BLE001 - never let embed crash a caller
        log.warning("chat_search: local embed failed: %r", exc)
        return None
    return out


# --- sqlite store ------------------------------------------------------------
def _connect() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB_PATH, timeout=10.0)
    # WAL lets a search read concurrently with the 30-min reindex write instead
    # of failing with "database is locked"; busy_timeout backstops any remaining
    # contention (e.g. the checkpoint) by waiting rather than erroring out.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            session_id   TEXT,
            session_name TEXT,
            msg_idx      INTEGER,
            role         TEXT,
            ts           INTEGER,
            text         TEXT,
            embedding    BLOB
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_session "
                 "ON chunks(session_id)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS indexed (
            session_id TEXT PRIMARY KEY,
            updated    INTEGER,
            msg_count  INTEGER
        )""")
    return conn


def _extract_chunks(session: dict, history: list[dict]) -> list[dict]:
    """Turn a session's mapped history into per-message chunks worth embedding:
    user/assistant messages with >=12 stripped chars, truncated to 1200 chars."""
    sid = session["id"]
    sname = session.get("name") or ""
    fallback_ts = session.get("updated") or 0
    chunks: list[dict] = []
    for idx, m in enumerate(history):
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content") or ""
        # Index what the user actually typed, not the injected context blocks
        # a turn may have been wrapped in (mentions, websearch, draft mode,
        # branch preamble, terminal notes): the same strip chain /api/history
        # renders with, so a note body can never surface as a chat snippet and
        # the real question is never pushed past the truncation cap.
        content = history_display.history_display_text(content)
        if not isinstance(content, str) or len(content.strip()) < _MIN_CONTENT_LEN:
            continue
        ts = (m.get("metadata") or {}).get("timestamp")
        if not isinstance(ts, (int, float)):
            ts = fallback_ts
        chunks.append({
            "session_id": sid,
            "session_name": sname,
            "msg_idx": idx,
            "role": role,
            "ts": int(ts),
            "text": content[:_MAX_TEXT_CHARS],
        })
    return chunks


def _prepend_history_backfill(session_id: str, history: list[dict]) -> list[dict]:
    p = config.DATA_DIR / "history_backfill" / f"{session_id}.json"
    try:
        payload = json.loads(p.read_text())
    except FileNotFoundError:
        return history
    except Exception as exc:  # noqa: BLE001 - bad backfill should not break indexing
        log.warning("chat_search: history backfill read failed for %s: %r",
                    session_id, exc)
        return history
    recovered = payload.get("history")
    if not isinstance(recovered, list) or not recovered:
        return history
    seen = {
        (m.get("role"), (m.get("content") or "").strip())
        for m in history if isinstance(m, dict)
    }
    merged = []
    for m in recovered:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        key = (role, content.strip())
        if key in seen:
            continue
        meta = dict(m.get("metadata") or {})
        meta.setdefault("backfilled", True)
        merged.append({"role": role, "content": content, "metadata": meta})
        seen.add(key)
    return merged + history if merged else history


async def _reindex_session(conn: sqlite3.Connection, session: dict,
                           force: bool) -> tuple[str, int]:
    """(Re)index one session. Returns ("indexed"|"skipped"|"error", n_chunks)."""
    sid = session["id"]
    updated = session.get("updated") or 0
    if not force:
        row = conn.execute(
            "SELECT updated FROM indexed WHERE session_id=?", (sid,)).fetchone()
        if row is not None and row[0] == updated:
            return "skipped", 0

    # strict=True: a gateway/WS failure raises instead of returning an empty
    # transcript. Without this a transient blip looks like "0 chunks" and the
    # DELETE below would wipe this session's good index (and re-stamp it current,
    # so it's never rebuilt). The caller catches and skips on the raise.
    hist = await bridge.fetch_history(session["sessionKey"], limit=_HISTORY_LIMIT,
                                      strict=True)
    history = _prepend_history_backfill(sid, hist.get("history") or [])
    chunks = _extract_chunks(session, history)
    if not chunks:
        # Defense in depth for the non-raising empty case (e.g. gateway returns
        # ok:true with an empty payload mid-restart): if we previously indexed
        # real content for this session, treat the sudden emptiness as suspect
        # and skip rather than delete. A truly-emptied transcript is impossible
        # here (transcripts only grow), so this never strands live content.
        prior = conn.execute(
            "SELECT msg_count FROM indexed WHERE session_id=?", (sid,)).fetchone()
        if prior is not None and prior[0]:
            return "skipped", 0

    embeddings: list[list[float]] = []
    if chunks:
        embeddings = await _embed([c["text"] for c in chunks], "document") or []
        if len(embeddings) != len(chunks):
            # Embedding failed (no key / API error) — don't wipe a good prior
            # index for this session; just skip it this run.
            raise RuntimeError("embed returned no/partial vectors")

    rows = [
        (c["session_id"], c["session_name"], c["msg_idx"], c["role"], c["ts"],
         c["text"], np.asarray(emb, dtype=np.float32).tobytes())
        for c, emb in zip(chunks, embeddings)
    ]
    with conn:  # transaction: replace this session's chunks atomically
        conn.execute("DELETE FROM chunks WHERE session_id=?", (sid,))
        if rows:
            conn.executemany(
                "INSERT INTO chunks (session_id, session_name, msg_idx, role, "
                "ts, text, embedding) VALUES (?,?,?,?,?,?,?)", rows)
        conn.execute(
            "INSERT INTO indexed (session_id, updated, msg_count) VALUES (?,?,?) "
            "ON CONFLICT(session_id) DO UPDATE SET updated=excluded.updated, "
            "msg_count=excluded.msg_count",
            (sid, updated, len(rows)))
    return "indexed", len(rows)


async def reindex(force: bool = False) -> dict:
    """Build/refresh the embedding index over all non-archived sessions.

    Incremental unless `force`: a session whose `updated` stamp is unchanged is
    skipped. One session's failure (gateway/embed error) is caught and logged so
    the run continues. Guarded by a lock — a call while a run is in progress
    returns early. Returns {sessions_indexed, chunks, skipped}."""
    if _reindex_lock.locked():
        log.info("chat_search: reindex already in progress — skipping")
        return {"sessions_indexed": 0, "chunks": 0, "skipped": 0,
                "note": "already running"}
    if not _embed_enabled():
        log.warning("chat_search: local embed endpoint unreachable — reindex skipped")
        return {"sessions_indexed": 0, "chunks": 0, "skipped": 0,
                "note": "embed endpoint unreachable"}

    async with _reindex_lock:
        conn = _connect()
        indexed = total_chunks = skipped = pruned = 0
        active_ids: set[str] = set()
        try:
            for s in sessions_store.list_sessions():
                if s.get("archived"):
                    continue
                active_ids.add(s.get("id"))
                try:
                    status, n = await _reindex_session(conn, s, force)
                except Exception as exc:  # noqa: BLE001 - isolate per-session
                    log.warning("chat_search: session %s failed: %r",
                                s.get("id"), exc)
                    continue
                if status == "indexed":
                    indexed += 1
                    total_chunks += n
                elif status == "skipped":
                    skipped += 1
            # Prune sessions that are no longer present-and-active (deleted or
            # newly archived) so search never returns dead hits that open a
            # missing/hidden conversation.
            cur = conn.execute("SELECT session_id FROM indexed")
            for (sid,) in cur.fetchall():
                if sid not in active_ids:
                    conn.execute("DELETE FROM chunks WHERE session_id=?", (sid,))
                    conn.execute("DELETE FROM indexed WHERE session_id=?", (sid,))
                    pruned += 1
            if pruned:
                conn.commit()
        finally:
            conn.close()
            # Only bust the cached matrix when the db actually changed — the
            # common every-30-min "nothing new" run must not force a full
            # re-read + re-vstack of every embedding on the next search. Runs in
            # `finally` (not after it) so a mid-prune exception, which may have
            # left committed per-session writes behind, still invalidates. The
            # db-mtime cache key can't be relied on here: WAL commits don't touch
            # the main db file's mtime until a checkpoint.
            if indexed or pruned:
                _invalidate_matrix_cache()
        log.info("chat_search: reindex done — indexed=%d chunks=%d skipped=%d pruned=%d",
                 indexed, total_chunks, skipped, pruned)
        return {"sessions_indexed": indexed, "chunks": total_chunks,
                "skipped": skipped, "pruned": pruned}


# --- search ------------------------------------------------------------------
def _invalidate_matrix_cache() -> None:
    with _MATRIX_LOCK:
        _matrix_cache["mtime"] = None
        _matrix_cache["matrix"] = None
        _matrix_cache["rows"] = None


def _load_matrix() -> tuple[np.ndarray | None, list]:
    """Load (and cache) the L2-normalized embedding matrix + row metadata from
    sqlite. Cache is keyed on the db file mtime; a reindex rewrites the file and
    bumps mtime, invalidating the cache."""
    try:
        mtime = _DB_PATH.stat().st_mtime
    except FileNotFoundError:
        return None, []
    with _MATRIX_LOCK:
        if _matrix_cache["mtime"] == mtime and _matrix_cache["matrix"] is not None:
            return _matrix_cache["matrix"], _matrix_cache["rows"]
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT session_id, session_name, role, ts, text, embedding FROM chunks")
        rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        with _MATRIX_LOCK:
            _matrix_cache.update({"mtime": mtime, "matrix": None, "rows": []})
        return None, []
    vecs = [np.frombuffer(r[5], dtype=np.float32) for r in rows]
    matrix = np.vstack(vecs).astype(np.float32)
    # Normalize rows once so search is a plain dot product.
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    matrix = matrix / norms
    meta = [(r[0], r[1], r[2], r[3], r[4]) for r in rows]  # sid,name,role,ts,text
    with _MATRIX_LOCK:
        _matrix_cache.update({"mtime": mtime, "matrix": matrix, "rows": meta})
    return matrix, meta


def _iso(ts) -> str:
    """Epoch-ms → ISO 8601 string (best-effort; empty on garbage)."""
    try:
        return datetime.datetime.fromtimestamp(
            int(ts) / 1000, tz=datetime.timezone.utc).isoformat()
    except (ValueError, OSError, TypeError, OverflowError):
        return ""


async def search(query: str, limit: int = 20) -> list[dict]:
    """Semantic search over indexed chat content. Empty query or no key → [].

    Embeds the query, cosine-ranks against the cached matrix, keeps the top
    `limit*4`, dedupes to at most 2 hits per session, and caps to `limit`.
    Each result: {session_id, session_name, role, content_snippet, timestamp
    (ISO 8601), score}."""
    query = (query or "").strip()
    if not query:
        return []
    # _load_matrix reads sqlite and (on a cache miss) vstacks the whole embedding
    # matrix — offload it so a cold search can't stall the event loop (and every
    # in-flight SSE chat stream) while it runs.
    matrix, meta = await asyncio.to_thread(_load_matrix)
    if matrix is None or not meta:
        return []
    q_emb = await _embed([query], "query")
    if not q_emb:
        return []
    q = np.asarray(q_emb[0], dtype=np.float32)
    qn = np.linalg.norm(q)
    if qn == 0:
        return []
    q = q / qn

    scores = matrix @ q  # cosine similarity (rows pre-normalized)
    pool = min(len(scores), max(limit * 4, limit))
    # Top `pool` indices, then order by score desc.
    top_idx = np.argpartition(-scores, pool - 1)[:pool]
    top_idx = top_idx[np.argsort(-scores[top_idx])]

    results: list[dict] = []
    per_session: dict[str, int] = {}
    for i in top_idx:
        sid, sname, role, ts, text = meta[i]
        if per_session.get(sid, 0) >= 2:
            continue
        per_session[sid] = per_session.get(sid, 0) + 1
        results.append({
            "session_id": sid,
            "session_name": sname,
            "role": role,
            "content_snippet": (text or "")[:_SNIPPET_CHARS],
            "timestamp": _iso(ts),
            "score": float(scores[i]),
        })
        if len(results) >= limit:
            break
    return results


def stats() -> dict:
    """Index stats: {chunks, sessions, has_key}. Never exposes the key value."""
    chunks = sessions = 0
    try:
        conn = _connect()
        try:
            chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            sessions = conn.execute(
                "SELECT COUNT(*) FROM indexed").fetchone()[0]
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("chat_search: stats failed: %r", exc)
    return {"chunks": chunks, "sessions": sessions,
            "has_key": _embed_enabled()}
