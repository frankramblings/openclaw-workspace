"""Deep Research — drive the OpenClaw agent (via the bridge) through a
web-research job and stream Odysseus-shaped progress events to the SPA.

The engine is the agent itself: codex already has web search + fetch tools
enabled, so a "research job" is 1-3 bridge turns on a dedicated gateway session
(`agent:main:web-research-<id>`):

  round turns   "research X, finish with a findings JSON block"  → findings
  final turn    "now write the report"                           → markdown

We watch the turn's tool cards to derive live progress (search tool → phase
"searching", fetch/read tool → "reading" with a source counter), which is what
drives the SPA's synapse animation. Counters are cumulative and phases follow
probing → planning → searching/reading → analyzing → writing → done, per the
contract captured in docs/superpowers/specs/2026-06-05-dead-tab-wiring-design.md.

Finished research persists to the agent vault (`~/.openclaw/workspace/Research/
<id>.md`, frontmatter + report body) — same files-in-the-vault pattern as
Notes/Documents, so the agent can read its own reports later.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

from . import bridge, config, sessions_store
from .fsutil import atomic_write_text, file_lock
from .research_render import render_html
from .vault_store import (WORKSPACE, dump_frontmatter, ensure_dir, new_id,
                          now_iso, parse_frontmatter)

router = APIRouter()

RESEARCH_DIR = WORKSPACE / "Research"

# A research turn can legitimately run for many minutes (multiple searches +
# page reads in one codex turn). Generous per-turn cap, env-overridable.
TURN_TIMEOUT_S = config._env_float("WORKSPACE_RESEARCH_TURN_TIMEOUT_S", 900.0)
MAX_ROUNDS = 3  # hard cap on search rounds regardless of the requested setting


# --- Job state ---------------------------------------------------------------

@dataclass
class Job:
    id: str
    query: str
    settings: dict
    status: str = "running"            # running | done | error | cancelled
    progress: dict = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    model: str = ""
    queries: int = 0
    total_sources: int = 0
    result: str | None = None
    sources: list = field(default_factory=list)
    findings: list = field(default_factory=list)
    comparison: dict | None = None    # {title,columns[...],rows[{label,cells[...]}]} when the query is a comparison
    category: str = ""
    subscribers: list = field(default_factory=list)   # asyncio.Queue per stream
    task: asyncio.Task | None = None


_JOBS: dict[str, Job] = {}
_JOB_TTL_S = 24 * 3600


def _prune_jobs() -> None:
    """Drop finished jobs past the TTL so _JOBS can't grow for the life of
    the process (reports persist on disk; only in-memory state is dropped)."""
    cutoff = time.time() - _JOB_TTL_S
    for rid, job in list(_JOBS.items()):
        if job.status != "running" and job.started_at < cutoff and not job.subscribers:
            del _JOBS[rid]


def _publish(job: Job, **fields) -> None:
    """Merge fields into the job's progress snapshot and fan out to streams.
    Counters live on the job and are re-stamped every event so they're always
    cumulative (the synapse requires monotonic counts)."""
    ev = {
        **job.progress, **fields,
        "status": job.status,
        "queries": job.queries,
        "total_sources": job.total_sources,
        "model": job.model,
        "started_at": int(job.started_at),
    }
    job.progress = ev
    for q in list(job.subscribers):
        q.put_nowait(ev)


def _finish(job: Job, status: str, error: str | None = None) -> None:
    job.status = status
    fields = {"final": True, "phase": "done" if status == "done" else status}
    if error:
        fields["error"] = error
    _publish(job, **fields)


# --- Pure helpers (unit-tested) ----------------------------------------------

_SEARCH_HINTS = ("search", "duckduckgo", "brave", "serpapi", "google", "bing")
_READ_HINTS = ("http", "fetch", "browse", "curl", "url", "web")


def classify_tool(name: str | None, command: str | None = None) -> str:
    """'search' for query tools, 'read' for web-fetch-looking ones, 'other' for
    the rest. The agent ALSO reads its own local files mid-turn (memory/SOUL
    bootstrap, scratch notes) — those must not count as research sources, so
    'read' requires a web hint rather than being the fallback. The gateway
    labels tools inconsistently across providers, so substring matching over
    name+command is the robust option."""
    hay = f"{name or ''} {command or ''}".lower()
    if any(h in hay for h in _SEARCH_HINTS):
        return "search"
    if any(h in hay for h in _READ_HINTS):
        return "read"
    return "other"


_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\[.*?\])\s*```", re.S)


def extract_findings(text: str) -> list[dict]:
    """Pull the findings array out of the agent's reply. Prefers the LAST fenced
    JSON block (rounds are told to output cumulative findings each time); falls
    back to the first bare top-level JSON array. Tolerant: returns [] on any
    parse failure, and drops entries that aren't {title|url|summary}-ish dicts."""
    candidates = _JSON_BLOCK_RE.findall(text or "")
    if not candidates:
        m = re.search(r"(\[\s*\{.*\}\s*\])", text or "", re.S)
        candidates = [m.group(1)] if m else []
    for raw in reversed(candidates):
        try:
            data = json.loads(raw)
        except Exception:  # noqa: BLE001 - try the previous block
            continue
        if isinstance(data, list):
            out = []
            for it in data:
                if isinstance(it, dict) and (it.get("title") or it.get("url")):
                    out.append({"title": str(it.get("title") or it.get("url") or ""),
                                "url": str(it.get("url") or ""),
                                "summary": str(it.get("summary") or "")})
            if out:
                return out
    return []


_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
_BARE_URL_RE = re.compile(r"(?<![(\[])(https?://[^\s)\]>'\"]+)")


def extract_sources(findings: list[dict], report: str = "") -> list[dict]:
    """Dedupe {title,url} source list: findings first (they carry titles), then
    any report links not already present (covers a findings-parse miss)."""
    seen: set[str] = set()
    sources: list[dict] = []

    def add(title: str, url: str) -> None:
        url = (url or "").rstrip(".,;")
        if not url or url in seen:
            return
        seen.add(url)
        sources.append({"title": title or url, "url": url})

    for f in findings:
        add(f.get("title", ""), f.get("url", ""))
    for title, url in _MD_LINK_RE.findall(report or ""):
        add(title, url)
    for url in _BARE_URL_RE.findall(report or ""):
        add("", url)
    return sources


def strip_findings_block(text: str) -> str:
    """The round reply minus its trailing findings JSON (for the summary shown
    nowhere yet, but keeps report prompts clean if we ever inline it)."""
    return _JSON_BLOCK_RE.sub("", text or "").strip()


def _model_ref(settings: dict) -> str | None:
    """settings {endpoint_id, model} → gateway "provider/model" ref (None = agent
    default), mirroring app._model_ref's semantics for chat sessions."""
    model = (settings.get("model") or "").strip()
    if not model or model == "openclaw":
        return None
    provider = (settings.get("endpoint_id") or "").strip()
    return f"{provider}/{model}" if provider and provider != "openclaw" else model


# --- Driving the agent --------------------------------------------------------

async def _agent_turn(message: str, session_key: str, model_ref: str | None,
                      on_event=None) -> str:
    """One bridge turn → the assistant's full text. Parses the bridge's SSE
    strings back into dicts and forwards each to on_event (tool cards drive the
    live phase display). Bridge/agent-level failures raise."""
    chunks: list[str] = []
    async for sse in bridge.stream_turn(message, session_key=session_key,
                                        model_ref=model_ref):
        if not sse.startswith("data:"):
            continue
        body = sse[5:].strip()
        if not body or body == "[DONE]":
            continue
        try:
            obj = json.loads(body)
        except Exception:  # noqa: BLE001
            continue
        if obj.get("delta"):
            chunks.append(obj["delta"])
        # The bridge surfaces turn-level failures as agent/bridge tool_output
        # cards with exit_code 1 (ordinary failed commands carry the tool name).
        if (obj.get("type") == "tool_output" and obj.get("exit_code") == 1
                and obj.get("tool") in ("bridge", "agent")):
            raise RuntimeError(obj.get("output") or "agent turn failed")
        if on_event:
            on_event(obj)
    return "".join(chunks)


_ROUND_PROMPT = """\
You are running round {round} of a deep-research job. Research this topic using \
your web tools — run several DISTINCT searches and fetch/read the most promising \
pages (do not answer from memory alone):

TOPIC: {query}
{extra}
When done, reply with a summary of what you learned (the key facts — it will be \
used to write the final report), then a fenced ```json block containing ONLY a \
cumulative array of findings for every source you have actually consulted so far \
(this round and earlier rounds), max 15 entries, each summary 2-3 informative \
sentences:
[{{"title": "...", "url": "...", "summary": "..."}}]"""

_GAP_EXTRA = """\
You already researched this in earlier rounds. Identify the most important gaps \
or weakly-sourced claims in your findings so far and run NEW searches to fill \
them. Do not repeat earlier queries.
"""

# The report turn runs on a FRESH session with the findings inlined: a research
# round can push the original session past the gateway's per-session token cap
# (observed live: 80.5k > 70k → "starting a fresh thread" mid-job), at which
# point session context is gone. Self-contained prompt → immune to that.
_REPORT_PROMPT = """\
Write the final deep-research report for this completed research job. Use the \
research notes and source findings below (supplement from your own knowledge \
only where it is uncontroversial). Output ONLY clean markdown (no preamble, no \
code fence around it):

# <a specific, descriptive title>

## Bottom Line
<2-4 sentences that directly answer the question first — the decision/verdict, \
not background. This leads the report.>

…then well-structured sections with the key facts and analysis, citing sources \
inline as [1], [2]…

## Sources
[1] <title> — <url>   (one line per source actually used)

TOPIC: {query}

RESEARCH NOTES:
{notes}

SOURCE FINDINGS:
{findings}"""


async def _turn(prompt: str, session_key: str, model_ref: str | None,
                on_event=None, expect=None) -> str:
    """One robust agent turn. The agent often delivers its real reply via the
    `message` tool, which can land in the transcript seconds AFTER the run's
    lifecycle end — the live delta stream then only carries a one-line stub
    (observed live: stub streamed, the 4k-char reply appeared in chat.history
    13s later). So: stream the turn, and if the streamed text doesn't satisfy
    `expect`, poll chat.history briefly for a longer assistant reply."""
    sent_at_ms = int(time.time() * 1000) - 2000  # small clock slack
    streamed = await asyncio.wait_for(
        _agent_turn(prompt, session_key, model_ref, on_event), TURN_TIMEOUT_S)
    if expect is None or expect(streamed):
        return streamed
    best = streamed
    for _ in range(6):
        await asyncio.sleep(4)
        try:
            hist = await bridge.fetch_history(session_key)
        except Exception:  # noqa: BLE001 - history is a recovery path only
            break
        tail = [m["content"] for m in hist.get("history") or []
                if m.get("role") == "assistant"
                and (m.get("metadata") or {}).get("timestamp", 0) and
                m["metadata"]["timestamp"] >= sent_at_ms]
        cand = max(tail, key=len, default="")
        if len(cand) > len(best):
            best = cand
        if expect(best):
            break
    return best


_COMPARE_RE = re.compile(
    r"\bvs\.?\b|\bversus\b|\bcompar(?:e|ison|ing)\b|\bdifference[s]?\b"
    r"|\bbetter\b|\bwhich (?:one|is|should)\b|\b(?:pros and cons|head[- ]to[- ]head)\b",
    re.I)


def _is_comparison(query: str) -> bool:
    """Cheap gate: does this query ask us to weigh two options against each other?
    Keeps the extra extraction turn off non-comparison reports."""
    return bool(_COMPARE_RE.search(query or ""))


_COMPARE_PROMPT = """The finished report below compares options. Extract a \
side-by-side comparison matrix as STRICT JSON so it can render as a grid.

Rules:
- One column per option actually compared (2 to 5). Put their real names in \
`columns`, ordered as the report emphasizes them.
- 5-11 rows, each a distinct dimension actually discussed in the report.
- Each row's `cells` array MUST have exactly one entry per column, in the same \
order as `columns`. Keep every cell short (a value/phrase, not a sentence). \
Preserve inline citation markers like [4] where the report has them.
- `winner`: the 0-based index of the best column for that row, or null if even/NA. \
`conflict`: true only when the sources disagree on that row.
- If the report is NOT actually a comparison of 2 or more options, output exactly: null

Output ONLY a fenced ```json block, nothing else:
```json
{{"title":"X vs Y vs Z — at a glance","dimension_label":"Feature","columns":["X","Y","Z"],
"rows":[{{"label":"...","cells":["...","...","..."],"winner":0,"conflict":false}}]}}
```

Query: {query}

Report:
{report}"""


def _parse_comparison(text: str) -> dict | None:
    m = re.search(r"```json\s*(.+?)```", text, re.S) or re.search(r"(\{.*\}|null)", text, re.S)
    if not m:
        return None
    blob = m.group(1).strip()
    if blob == "null":
        return None
    try:
        data = json.loads(blob)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list) or not data["rows"]:
        return None
    # keep only well-formed rows
    data["rows"] = [r for r in data["rows"] if isinstance(r, dict) and r.get("label")]
    return data if data["rows"] else None


async def _maybe_compare(job: Job, session_key: str, model_ref: str | None) -> None:
    """For comparison queries, run one extra writer turn to distill a matrix.
    Best-effort: any failure just leaves the report without a grid."""
    if not _is_comparison(job.query) or not job.result:
        return
    try:
        text = await asyncio.wait_for(
            _turn(_COMPARE_PROMPT.format(query=job.query, result=job.result,
                                         report=job.result[:12000]),
                  f"{session_key}-compare", model_ref,
                  expect=lambda t: "```json" in t or "null" in t),
            timeout=180)
        job.comparison = _parse_comparison(text)
    except Exception:  # noqa: BLE001 - grid is an enrichment, never fatal
        job.comparison = None


async def _run(job: Job) -> None:
    session_key = f"{config.web_session_prefix()}-research-{job.id}"
    model_ref = _model_ref(job.settings)
    rounds = int(job.settings.get("max_rounds") or 1)
    rounds = max(1, min(rounds, MAX_ROUNDS))
    try:
        _publish(job, phase="probing", round=1)
        notes: list[str] = []
        for rnd in range(1, rounds + 1):
            _publish(job, phase="planning", round=rnd)

            def on_event(obj, _rnd=rnd):
                if obj.get("type") != "tool_start":
                    return
                kind = classify_tool(obj.get("tool"), obj.get("command"))
                if kind == "search":
                    job.queries += 1
                    _publish(job, phase="searching", round=_rnd)
                elif kind == "read":
                    job.total_sources += 1
                    title = str(obj.get("command") or obj.get("tool") or "")[:80]
                    _publish(job, phase="reading", round=_rnd, title=title)
                # 'other' = the agent housekeeping its own files — not progress

            prompt = _ROUND_PROMPT.format(round=rnd, query=job.query,
                                          extra=_GAP_EXTRA if rnd > 1 else "")
            text = await _turn(prompt, session_key, model_ref, on_event,
                               expect=lambda t: bool(extract_findings(t)))
            job.findings = extract_findings(text) or job.findings
            notes.append(strip_findings_block(text)[:6000])
            _publish(job, phase="analyzing", round=rnd,
                     total_findings=len(job.findings))

        _publish(job, phase="writing", total_findings=len(job.findings))
        report_prompt = _REPORT_PROMPT.format(
            query=job.query,
            notes="\n\n".join(n for n in notes if n) or "(none captured)",
            findings=json.dumps(job.findings, ensure_ascii=False, indent=1))
        # Fresh session for the writer — see _REPORT_PROMPT's comment.
        report = await _turn(report_prompt, f"{session_key}-write", model_ref,
                             expect=lambda t: len(t.strip()) > 400)
        if not report.strip():
            raise RuntimeError("the agent returned an empty report")

        job.result = report
        job.sources = extract_sources(job.findings, report)
        # Smart layout: comparison queries get a side-by-side grid distilled
        # from the report (best-effort; skipped for non-comparisons).
        _publish(job, phase="writing", total_findings=len(job.findings))
        await _maybe_compare(job, session_key, model_ref)
        _save_record(job, rounds)
        _finish(job, "done")
    except asyncio.CancelledError:
        _finish(job, "cancelled")
        raise
    except TimeoutError:
        _finish(job, "error",
                error=f"research turn timed out after {int(TURN_TIMEOUT_S)}s")
    except Exception as exc:  # noqa: BLE001 - surface into the job card
        _finish(job, "error", error=str(exc) or repr(exc))


# --- Vault persistence ---------------------------------------------------------

def _record_path(rid: str):
    return RESEARCH_DIR / f"{rid}.md"


def _save_record(job: Job, rounds: int) -> None:
    ensure_dir(RESEARCH_DIR)
    meta = {
        "id": job.id,
        "query": job.query,
        "status": "done",
        "started_at": int(job.started_at),
        "duration": f"{max(1, int(time.time() - job.started_at))}s",
        "source_count": len(job.sources),
        "rounds": rounds,
        "category": job.category,
        "model": job.model,
        "archived": False,
        "created": now_iso(),
        "sources": job.sources,
        "findings": job.findings,
    }
    if job.comparison:
        meta["comparison"] = job.comparison
    path = _record_path(job.id)
    with file_lock(path):
        atomic_write_text(path, dump_frontmatter(meta, job.result or ""))


def _load_record(rid: str) -> dict | None:
    """Disk record → dict with the report body under "result". None if absent.
    The id comes from the filename so a hand-dropped file still lists."""
    path = _record_path(rid)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", rid or "") or not path.is_file():
        return None
    meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
    meta.setdefault("id", rid)
    meta["result"] = body
    return meta


def _list_records() -> list[dict]:
    if not RESEARCH_DIR.is_dir():
        return []
    out = []
    for p in RESEARCH_DIR.glob("*.md"):
        rec = _load_record(p.stem)
        if rec and not rec.get("archived"):
            out.append(rec)
    out.sort(key=lambda r: r.get("started_at") or 0, reverse=True)
    return out


# --- API ------------------------------------------------------------------------

@router.post("/api/research/start")
async def start(payload: dict):
    query = (payload.get("query") or "").strip()
    if not query:
        return JSONResponse(status_code=400, content={"detail": "query is required"})
    _prune_jobs()
    job = Job(id=new_id(), query=query, settings=payload,
              category=payload.get("category") or "")
    job.model = (payload.get("_modelName") or payload.get("model")
                 or config.default_model()[1])
    _JOBS[job.id] = job
    job.task = asyncio.create_task(_run(job))
    return {"session_id": job.id}


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


@router.get("/api/research/stream/{rid}")
async def stream(rid: str):
    async def gen():
        job = _JOBS.get(rid)
        if job is None:
            rec = _load_record(rid)
            if rec:  # finished in an earlier process life — report it terminal
                yield _sse({"final": True, "status": rec.get("status", "done"),
                            "phase": "done"})
            else:
                yield _sse({"status": "not_found"})
            return
        q: asyncio.Queue = asyncio.Queue()
        job.subscribers.append(q)
        try:
            if job.progress:
                yield _sse(job.progress)
            if job.progress.get("final") or job.status != "running":
                return
            while True:
                ev = await q.get()
                yield _sse(ev)
                if ev.get("final"):
                    return
        finally:
            if q in job.subscribers:
                job.subscribers.remove(q)

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("/api/research/status/{rid}")
async def status(rid: str):
    job = _JOBS.get(rid)
    if job:
        return {"status": job.status, "progress": job.progress}
    rec = _load_record(rid)
    if rec:
        return {"status": rec.get("status", "done"), "progress": {}}
    return JSONResponse(status_code=404, content={"detail": "no such research"})


@router.get("/api/research/active")
async def active():
    return {"active": [
        {"session_id": j.id, "query": j.query, "progress": j.progress,
         "started_at": int(j.started_at)}
        for j in _JOBS.values() if j.status == "running"
    ]}


@router.get("/api/research/library")
async def library(sort: str = "recent", limit: int = 20):
    recs = _list_records()[:max(1, min(limit, 200))]
    return {"research": [
        {k: r.get(k) for k in ("id", "query", "status", "started_at", "duration",
                               "source_count", "rounds", "category")}
        for r in recs
    ]}


@router.post("/api/research/result-peek/{rid}")
async def result_peek(rid: str):
    job = _JOBS.get(rid)
    if job and job.result is not None:
        return {"result": job.result, "sources": job.sources,
                "raw_findings": job.findings, "category": job.category}
    rec = _load_record(rid)
    if rec:
        return {"result": rec.get("result", ""), "sources": rec.get("sources") or [],
                "raw_findings": rec.get("findings") or [],
                "category": rec.get("category") or ""}
    return JSONResponse(status_code=404, content={"detail": "no such research"})


@router.post("/api/research/cancel/{rid}")
async def cancel(rid: str):
    job = _JOBS.get(rid)
    if job and job.task and job.status == "running":
        job.task.cancel()
    return {"ok": True}


@router.delete("/api/research/{rid}")
async def delete(rid: str):
    _JOBS.pop(rid, None)
    path = _record_path(rid)
    if re.fullmatch(r"[A-Za-z0-9_-]+", rid or "") and path.is_file():
        path.unlink()
        return {"ok": True}
    return {"ok": False}


@router.post("/api/research/{rid}/archive")
async def archive(rid: str):
    rec = _load_record(rid)
    if not rec:
        return JSONResponse(status_code=404, content={"detail": "no such research"})
    body = rec.pop("result", "")
    rec["archived"] = True
    path = _record_path(rid)
    with file_lock(path):
        atomic_write_text(path, dump_frontmatter(rec, body))
    return {"ok": True}


@router.post("/api/research/spinoff/{rid}")
async def spinoff(rid: str):
    """Server-side "chat about this research": mint a normal chat session whose
    gateway thread is pre-seeded with the report, then hand its id to the SPA.
    The seed turn is awaited so the context exists before the user types."""
    job = _JOBS.get(rid)
    rec = {"query": job.query, "result": job.result} if job and job.result \
        else _load_record(rid)
    if not rec or not rec.get("result"):
        return JSONResponse(status_code=404, content={"detail": "no such research"})
    sess = sessions_store.create(name=f"Research: {rec['query'][:48]}")
    seed = ("Context for this conversation — a deep-research report I just "
            f"completed on \"{rec['query']}\":\n\n{rec['result']}\n\n"
            "Reply with one short sentence confirming you've read it; the user "
            "will ask follow-up questions next.")
    try:
        await asyncio.wait_for(
            _agent_turn(seed, sess["sessionKey"], None), timeout=120)
    except Exception as exc:  # noqa: BLE001 - session exists; context seeding failed
        sessions_store.delete(sess["id"])
        return JSONResponse(status_code=502,
                            content={"detail": f"could not seed the chat: {exc}"})
    return {"session_id": sess["id"]}


_REPORT_PAGE = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  body {{ margin: 0; background: #0f1115; color: #e6e6e6;
         font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
  main {{ max-width: 780px; margin: 0 auto; padding: 48px 24px 96px; }}
  a {{ color: #7aa2f7; }}
  pre {{ white-space: pre-wrap; word-break: break-word; }}
  h1, h2, h3 {{ line-height: 1.3; }}
  .meta {{ color: #888; font-size: 13px; margin-bottom: 32px; }}
  code {{ background: #1a1f29; padding: 2px 5px; border-radius: 4px; }}
</style></head>
<body><main>
  <div class="meta">Deep research · {meta}</div>
  <div id="report"></div>
  <script type="text/plain" id="md-src">{md}</script>
  <script type="module">
    const md = document.getElementById('md-src').textContent;
    const esc = s => s.replace(/[&<>]/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;'}}[c]));
    try {{
      const m = await import('/static/js/markdown.js');
      document.getElementById('report').innerHTML = m.mdToHtml(md);
    }} catch (e) {{
      document.getElementById('report').innerHTML = '<pre>' + esc(md) + '</pre>';
    }}
  </script>
</main></body></html>"""


@router.get("/api/research/report/{rid}")
async def report(rid: str):
    # Prefer the persisted record (carries sources/findings/rounds/model/
    # comparison for the rich renderer); fall back to a live job that hasn't
    # been saved yet.
    rec = _load_record(rid)
    if not rec:
        job = _JOBS.get(rid)
        if job and job.result:
            rec = {"query": job.query, "result": job.result,
                   "sources": job.sources, "findings": job.findings,
                   "source_count": len(job.sources), "model": job.model}
    if not rec or not rec.get("result"):
        return HTMLResponse("<h1>No report (yet)</h1>", status_code=404)
    try:
        return HTMLResponse(render_html(rec))
    except Exception:  # noqa: BLE001 - never 500 the report; degrade to text
        md = (rec.get("result") or "").replace("</script", "<\\/script")
        meta_bits = [rec.get("query") or "", f"{rec.get('source_count') or 0} sources"]
        if rec.get("duration"):
            meta_bits.append(rec["duration"])
        return HTMLResponse(_REPORT_PAGE.format(
            title=(rec.get("query") or "Research")[:80],
            meta=" · ".join(b for b in meta_bits if b), md=md))


@router.get("/api/model-endpoints")
async def model_endpoints():
    """The research panel's endpoint/model picker. Map the gateway catalog onto
    Odysseus's model-endpoints shape (bare array)."""
    try:
        items = (await bridge.fetch_models()).get("items") or []
    except Exception:  # noqa: BLE001 - picker just falls back to "Default"
        return []
    return [{"id": it["endpoint_id"], "name": it.get("endpoint_name") or it["endpoint_id"],
             "base_url": it.get("url", ""), "is_enabled": not it.get("offline"),
             "model_type": "llm", "models": it.get("models") or []}
            for it in items]
