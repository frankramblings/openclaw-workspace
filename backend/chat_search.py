"""Semantic (embedding-based) search over all chat message CONTENT.

Message content lives in the brain and is read back per-session via
`bridge.fetch_history`. This module builds a local embedding index of that
content in sqlite (`.data/chat_search.db`) and serves cosine-similarity search
over it. Embeddings come from Voyage AI's HTTP API (voyage-3.5-lite).

Design constraints (single user, small scale ~291 sessions):
  * Incremental: a session is re-embedded only when its `updated` stamp moves.
  * Resilient: one session's gateway/embed failure never aborts a full reindex.
  * Graceful degradation: no Voyage key → indexing/search are no-ops that log a
    warning and return empty, never raise.
  * Cheap search: the embedding matrix is cached in-process keyed on the db
    file mtime, so repeated queries don't re-read sqlite.

The Voyage API key is read from env `VOYAGE_API_KEY`, falling back to the
`VOYAGE_API_KEY=` line in ~/.config/openclaw-secrets/ramblebot.env. The key
value is NEVER logged or returned.
"""
from __future__ import annotations

import asyncio
import datetime
import logging
import os
import sqlite3
import threading
from pathlib import Path

import httpx
import numpy as np

from . import bridge, config, sessions_store

log = logging.getLogger("workspace.chat_search")

# --- Tunables ----------------------------------------------------------------
_DB_PATH = config.DATA_DIR / "chat_search.db"
_SECRETS_ENV = Path.home() / ".config" / "openclaw-secrets" / "ramblebot.env"
_VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
_VOYAGE_MODEL = "voyage-3.5-lite"
_MAX_TEXT_CHARS = 1200      # truncate each chunk before embedding
_SNIPPET_CHARS = 240        # content_snippet length in results
_BATCH = 128                # Voyage: max inputs per request
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


# --- Voyage API key ----------------------------------------------------------
def _voyage_key() -> str | None:
    """Return the Voyage API key from env, or parse it from the secrets env
    file. Returns None if unavailable. The value is never logged."""
    env = os.environ.get("VOYAGE_API_KEY")
    if env:
        return env.strip()
    try:
        for line in _SECRETS_ENV.read_text().splitlines():
            line = line.strip()
            if line.startswith("VOYAGE_API_KEY="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                return val or None
    except (FileNotFoundError, OSError):
        return None
    return None


async def _embed(texts: list[str], input_type: str) -> list[list[float]] | None:
    """Embed `texts` via Voyage in batches of <=128. `input_type` is
    "document" (indexing) or "query" (search). Returns a list of float vectors
    aligned with `texts`, or None if no key / a hard API failure. Best-effort:
    on a batch error it logs and returns None so callers degrade gracefully."""
    key = _voyage_key()
    if not key:
        log.warning("chat_search: no Voyage API key found — search disabled")
        return None
    out: list[list[float]] = []
    headers = {"Authorization": f"Bearer {key}",
               "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            for i in range(0, len(texts), _BATCH):
                batch = texts[i:i + _BATCH]
                body = {"input": batch, "model": _VOYAGE_MODEL,
                        "input_type": input_type}
                res = await client.post(_VOYAGE_URL, json=body, headers=headers)
                if res.status_code != 200:
                    log.warning("chat_search: Voyage returned %s (batch %d)",
                                res.status_code, i // _BATCH)
                    return None
                data = res.json().get("data") or []
                # Order by index to be safe, then take embeddings.
                data.sort(key=lambda d: d.get("index", 0))
                out.extend(d["embedding"] for d in data)
    except Exception as exc:  # noqa: BLE001 - never let embed crash a caller
        log.warning("chat_search: Voyage embed failed: %r", exc)
        return None
    return out


# --- sqlite store ------------------------------------------------------------
def _connect() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB_PATH)
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

    hist = await bridge.fetch_history(session["sessionKey"], limit=_HISTORY_LIMIT)
    chunks = _extract_chunks(session, hist.get("history") or [])

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
    if not _voyage_key():
        log.warning("chat_search: no Voyage API key — reindex skipped")
        return {"sessions_indexed": 0, "chunks": 0, "skipped": 0,
                "note": "no key"}

    async with _reindex_lock:
        conn = _connect()
        indexed = total_chunks = skipped = 0
        try:
            for s in sessions_store.list_sessions():
                if s.get("archived"):
                    continue
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
        finally:
            conn.close()
        _invalidate_matrix_cache()
        log.info("chat_search: reindex done — indexed=%d chunks=%d skipped=%d",
                 indexed, total_chunks, skipped)
        return {"sessions_indexed": indexed, "chunks": total_chunks,
                "skipped": skipped}


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
    matrix, meta = _load_matrix()
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
            "has_key": _voyage_key() is not None}
