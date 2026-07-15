from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

router = APIRouter()

_REPO_ROOT = Path(__file__).resolve().parents[1]
_PPLX_CLI = _REPO_ROOT / "tools" / "perplexity-agent" / "src" / "cli.mjs"
_TIMEOUT_S = 120


def _clamp_rounds(value) -> int:
    try:
        rounds = int(value)
    except (TypeError, ValueError):
        return 4
    return max(1, min(rounds, 8))


async def _run_sidecar(prompt: str, *, model: str = "", max_rounds: int = 4) -> dict:
    cmd = [str(_PPLX_CLI), "--json", "--max-rounds", str(_clamp_rounds(max_rounds))]
    if model:
        cmd.extend(["--model", model])
    cmd.append(prompt)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(_REPO_ROOT / "tools" / "perplexity-agent"),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_TIMEOUT_S)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Perplexity sidecar timed out") from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Perplexity sidecar unavailable: {exc}") from exc

    out = stdout.decode("utf-8", "replace").strip()
    err = stderr.decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        detail = err or out or f"Perplexity sidecar exited {proc.returncode}"
        raise HTTPException(status_code=502, detail=detail[:1000])
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        detail = out or err or "Perplexity sidecar returned invalid JSON"
        raise HTTPException(status_code=502, detail=detail[:1000]) from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Perplexity sidecar returned invalid JSON shape")
    return data


@router.post("/api/perplexity-agent/ask")
async def ask_perplexity_agent(body: dict = Body(...)):
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    model = str(body.get("model") or "").strip()
    max_rounds = _clamp_rounds(body.get("max_rounds", body.get("maxRounds", 4)))
    return await _run_sidecar(prompt, model=model, max_rounds=max_rounds)
