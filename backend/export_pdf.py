"""Server-side transcript → PDF, for a true one-click download.

The chat "Export as PDF" action builds a print-ready HTML document client-side
(reusing the app's own markdown renderer via `buildTranscriptHtml`), the same
HTML that used to be handed to the browser's print dialog. Here we take that
HTML and render it to a real PDF with headless Google Chrome
(`--print-to-pdf`), so the client can download the file in one click with no
print dialog — and with identical fidelity, since it's the same rendering
engine on the same HTML (selectable text, styled code blocks, page breaks).

Chrome is the only viable engine on this host (snap chromium is confined and
its sandbox is broken; see workspace memory). We shell out rather than pull in
a Python PDF lib to keep zero new Python dependencies and match the exact look
of the previous print-to-PDF output.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
from pathlib import Path

from fastapi import Body
from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

router = APIRouter()

# Prefer real Google Chrome (snap chromium is confined/broken on this host).
_CHROME_CANDIDATES = [
    os.environ.get("WORKSPACE_CHROME_BIN"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    shutil.which("google-chrome"),
    shutil.which("google-chrome-stable"),
    shutil.which("chromium"),
    shutil.which("chromium-browser"),
]


def _chrome_bin() -> str | None:
    for c in _CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    return None


def _safe_filename(name: str | None) -> str:
    base = re.sub(r"[^\w.-]+", "_", (name or "conversation").strip()) or "conversation"
    base = base[:120].rstrip("._-") or "conversation"
    if not base.lower().endswith(".pdf"):
        base += ".pdf"
    return base


@router.post("/api/export/pdf")
async def export_pdf(payload: dict = Body(...)):
    """Render client-supplied transcript HTML to a downloadable PDF."""
    html = (payload or {}).get("html")
    if not isinstance(html, str) or not html.strip():
        return JSONResponse({"error": "missing html"}, status_code=400)

    chrome = _chrome_bin()
    if not chrome:
        return JSONResponse({"error": "no chrome binary available"}, status_code=503)

    filename = _safe_filename((payload or {}).get("filename"))

    tmpdir = tempfile.mkdtemp(prefix="gary-pdf-")
    src = Path(tmpdir) / "transcript.html"
    out = Path(tmpdir) / "transcript.pdf"
    try:
        src.write_text(html, encoding="utf-8")
        proc = await asyncio.create_subprocess_exec(
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--disable-dev-shm-usage",
            f"--print-to-pdf={out}",
            src.as_uri(),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return JSONResponse({"error": "pdf render timed out"}, status_code=504)

        if not out.exists() or out.stat().st_size == 0:
            msg = (stderr or b"").decode("utf-8", "replace")[-400:]
            return JSONResponse({"error": "pdf render failed", "detail": msg}, status_code=500)

        data = out.read_bytes()
        return Response(
            content=data,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
