"""Live Jobs API — reads the bin/job registry and streams progress to the SPA.

Layer 2 of the Live Jobs design (docs/superpowers/specs/2026-06-30-workspace-live-jobs-design.md).

The registry is a directory of atomic JSON files written by `bin/job`
(`$WORKSPACE/tmp/jobs/<id>.json`). This router only READS them — it never
writes, so it stays fully decoupled from producers.

  GET /api/jobs          -> {"jobs": [ …records… ]}  (running first, newest first)
  GET /api/jobs/stream   -> text/event-stream; snapshot on connect, then a framed
                            record list whenever it changes. Source of truth is
                            task_registry (fed by task_ingest's scan loop); the
                            idle keepalive tick re-applies the 60s terminal
                            window so finished cards age out without an event.

Fail-soft everywhere: a malformed/partial file is skipped, never fatal.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import (HTMLResponse, PlainTextResponse,
                               StreamingResponse)

from . import task_registry
from .vault_store import WORKSPACE

_ID_RE = re.compile(r"^[A-Za-z0-9_]+$")   # job ids are safe tokens; reject the rest

router = APIRouter()

JOBS_DIR = WORKSPACE / "tmp" / "jobs"

RETAIN_SECS = 60          # terminal jobs older than this are dropped from output
                          # (tighter than the registry's own RETAIN_TERMINAL_S —
                          # /api/jobs has always aged terminal rows out faster)

_KEEPALIVE_S = 15.0       # idle SSE tick: keepalive comment + terminal-window re-check

# Internal bookkeeping fields we don't leak to the client.
_PRIVATE = ("_updatedEpoch", "_pctExplicit")


def _native(rec: dict) -> dict:
    """Reconstruct the bin/job native record from a registry entry: the
    ingested payload verbatim, private fields stripped, `stalled` injected
    when the registry derived it. This is the compat contract — the overlay
    and /jobs/live were built against these exact fields."""
    out = dict((rec.get("extra") or {}).get("native") or {})
    for k in _PRIVATE:
        out.pop(k, None)
    if rec.get("state") == "stalled":
        updated = (rec.get("extra") or {}).get("updated_epoch") or 0
        out["stalled"] = int(time.time() - updated) if updated else 1
    return out


def _read_all() -> list[dict]:
    """All current job records from the registry (source=job only), cleaned +
    sorted running-first / newest-first — the same output contract the
    directory-globbing implementation had. Re-applies the legacy RETAIN_SECS
    terminal window on top of the registry's own (longer) RETAIN_TERMINAL_S,
    using the registry record's own `updated` timestamp — not the native
    payload's — since that's what the registry actually ages records by.
    """
    now_ms = time.time() * 1000
    recs: list[dict] = []
    for rec in task_registry.list_tasks(source="job"):
        native = _native(rec)
        if not native.get("id"):
            continue
        if (native.get("status") in ("done", "failed")
                and now_ms - rec["updated"] > RETAIN_SECS * 1000):
            continue
        recs.append(native)

    order = {"running": 0, "failed": 1, "done": 2}
    recs.sort(key=lambda r: (order.get(r.get("status"), 3),
                             _neg(r.get("startedAt", ""))))
    return recs


def _neg(s: str):
    # sort strings descending by negating their sort position via reverse tuple
    return tuple(-ord(c) for c in s)


def _sse(obj) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


@router.get("/api/jobs")
async def jobs():
    return {"jobs": _read_all()}


async def _stream_gen():
    queue = task_registry.subscribe()
    try:
        # emit an immediate snapshot so the client renders without waiting a tick
        snap = _read_all()
        last = json.dumps(snap, separators=(",", ":"))
        yield _sse({"jobs": snap})
        while True:
            try:
                rec = await asyncio.wait_for(queue.get(), timeout=_KEEPALIVE_S)
            except asyncio.TimeoutError:
                if not task_registry.is_subscribed(queue):
                    return          # dropped (QueueFull): end the stream; client resnapshots
                # This tick doubles as the self-heal pass for the time-based
                # RETAIN_SECS window: a terminal job crossing the 60s cutoff
                # produces no registry event, so re-check the list here.
                cur = _read_all()
                key = json.dumps(cur, separators=(",", ":"))
                if key != last:
                    last = key
                    yield _sse({"jobs": cur})
                else:
                    yield ": keepalive\n\n"
                continue
            if rec.get("source") != "job":
                continue
            cur = _read_all()
            key = json.dumps(cur, separators=(",", ":"))
            if key != last:
                last = key
                yield _sse({"jobs": cur})
    finally:
        task_registry.unsubscribe(queue)


@router.get("/api/jobs/stream")
async def jobs_stream():
    return StreamingResponse(_stream_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# Terminal-mirror band-aid: a per-job raw log tail + a standalone page that
# renders it. Deliberately OUTSIDE the SPA bundle so it works on devices whose
# cached PWA shell predates the Live Jobs overlay (the mobile "not showing"
# case). `bin/job-run` tees the child's stdout/stderr to tmp/jobs/<id>.log.
# ---------------------------------------------------------------------------

def _tail(path: Path, n: int) -> str:
    try:
        data = path.read_text(errors="replace")
    except Exception:
        return ""
    lines = data.splitlines()
    return "\n".join(lines[-n:])


@router.get("/api/jobs/{jid}/log", response_class=PlainTextResponse)
async def job_log(jid: str, tail: int = 300):
    """Last `tail` lines of a job's mirrored terminal output (plain text)."""
    if not _ID_RE.match(jid):
        return PlainTextResponse("", status_code=404)
    tail = max(1, min(tail, 2000))
    body = _tail(JOBS_DIR / f"{jid}.log", tail)
    return PlainTextResponse(body, headers={"Cache-Control": "no-store"})


_LIVE_HTML = """<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>Live Jobs</title>
<style>
:root{--bg:#0d0f13;--panel:#171a20;--bd:#2a2f38;--fg:#e8e8ea;--mut:#9aa0aa;
  --accent:#5b9dff;--ok:#3fbf6f;--err:#e5534b;--amber:#d8a24a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;
  padding:14px 12px calc(24px + env(safe-area-inset-bottom))}
h1{font-size:15px;margin:2px 4px 12px;display:flex;align-items:center;gap:8px}
h1 .dot{width:8px;height:8px;border-radius:50%;background:var(--mut)}
h1.live .dot{background:var(--accent);box-shadow:0 0 0 0 var(--accent);animation:p 1.6s infinite}
@keyframes p{0%{box-shadow:0 0 0 0 rgba(91,157,255,.5)}70%{box-shadow:0 0 0 7px rgba(91,157,255,0)}100%{box-shadow:0 0 0 0 rgba(91,157,255,0)}}
.job{background:var(--panel);border:1px solid var(--bd);border-left:3px solid var(--bd);
  border-radius:11px;padding:11px 12px;margin:0 0 11px}
.job.running{border-left-color:var(--accent)}
.job.done{border-left-color:var(--ok)}
.job.failed{border-left-color:var(--err)}
.job.stalled{border-left-color:var(--amber)}
.top{display:flex;align-items:baseline;gap:8px;margin-bottom:7px}
.lbl{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pct{font-variant-numeric:tabular-nums;color:var(--mut)}
.track{height:6px;border-radius:3px;background:#2a2f38;overflow:hidden;margin-bottom:7px}
.fill{height:100%;width:0;background:var(--accent);border-radius:3px;transition:width .4s ease}
.job.done .fill{background:var(--ok)}.job.failed .fill{background:var(--err)}
.meta{color:var(--mut);font-size:12px;margin-bottom:8px}
pre{margin:0;max-height:44vh;overflow:auto;background:#0a0c10;border:1px solid var(--bd);
  border-radius:8px;padding:9px 10px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;
  white-space:pre-wrap;word-break:break-word;color:#cfd3da}
.empty{color:var(--mut);text-align:center;padding:40px 0}
.err{color:#e5847e;font-size:12px;margin-bottom:6px}
</style></head><body>
<h1 id="h"><span class="dot"></span><span id="ht">Live Jobs</span></h1>
<div id="root"><div class="empty">Loading…</div></div>
<script>
const R=document.getElementById('root'),H=document.getElementById('h'),HT=document.getElementById('ht');
const stick={};              // per-job: is the log scrolled to bottom?
const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function logFor(id){try{const r=await fetch('/api/jobs/'+id+'/log?tail=400',{cache:'no-store'});
  return r.ok?await r.text():'';}catch(_){return'';}}
async function tick(){
  let jobs=[];try{const r=await fetch('/api/jobs',{cache:'no-store'});jobs=(await r.json()).jobs||[];}
  catch(_){HT.textContent='Live Jobs — offline';H.classList.remove('live');return;}
  const running=jobs.filter(j=>j.status==='running').length;
  H.classList.toggle('live',running>0);
  HT.textContent=running>0?running+' running':(jobs.length?'Jobs done':'No jobs');
  if(!jobs.length){R.innerHTML='<div class="empty">No jobs running.</div>';return;}
  const logs=await Promise.all(jobs.map(j=>logFor(j.id)));
  R.innerHTML=jobs.map((j,i)=>{
    const cls=['job',j.status];if(j.stalled)cls.push('stalled');
    const pct=j.status==='done'?100:(j.pct!=null?j.pct:0);
    const pl=j.status==='done'?'✓':j.status==='failed'?'✕':(j.pct!=null?Math.round(j.pct)+'%':'');
    const meta=[j.detail,j.eta?('ETA '+j.eta+'s'):'',j.stalled?('no update '+j.stalled+'s'):'']
      .filter(Boolean).map(esc).join(' · ');
    const log=logs[i]||'';
    return `<div class="${cls.join(' ')}">
      <div class="top"><span class="lbl">${esc(j.label||j.id)}</span><span class="pct">${pl}</span></div>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div>
      ${meta?`<div class="meta">${meta}</div>`:''}
      ${j.error?`<div class="err">${esc(j.error)}</div>`:''}
      ${log?`<pre data-id="${esc(j.id)}">${esc(log)}</pre>`:''}
    </div>`;}).join('');
  R.querySelectorAll('pre').forEach(p=>{const id=p.dataset.id;
    if(stick[id]!==false)p.scrollTop=p.scrollHeight;   // auto-follow unless user scrolled up
    p.onscroll=()=>{stick[id]=p.scrollHeight-p.scrollTop-p.clientHeight<24;};});
}
tick();setInterval(tick,1500);
</script></body></html>"""


@router.get("/jobs/live", response_class=HTMLResponse)
async def jobs_live():
    """Standalone raw-tail page — SW never caches this route, so it renders on
    devices whose PWA shell is stale. Poll-based; no SPA dependency."""
    return HTMLResponse(_LIVE_HTML, headers={"Cache-Control": "no-store"})
