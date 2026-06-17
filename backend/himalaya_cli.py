"""Thin async wrapper over the himalaya CLI (v1.2.0).

One job: run himalaya with an arg list, return parsed JSON / raw bytes, normalize
failures into HimalayaError. Stateless — a fresh process per call (same pattern as
the other adapters). himalaya speaks IMAP/SMTP to Gmail; config + credential live
outside the repo (~/.config/himalaya/).

Probed shapes (v1.2.0, 2026-06-04):
  folder list   -o json -> [{"name","desc"}]
  envelope list -o json -> [{"id","flags":[],"subject","from":{"name","addr"},
                             "to":{"name","addr"},"date","has_attachment"}]
                           pages via -p <page> / -s <page-size>
  message read           -> flat text (string); --preview avoids \\Seen
  message export -F      -> writes full <id>.eml to CWD (parse with email stdlib)
  flag add/remove <id> <FLAG> -f <folder>
  message move/copy <id> <target> -f <source>;  message send <raw> (stdin)
himalaya emits a harmless imap_codec WARN on stderr — we read stdout only.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil

# Resolve the binary once. The LaunchAgent's PATH includes /usr/local/bin, but be
# explicit so it works regardless of the caller's environment.
HIMALAYA_BIN = (os.environ.get("HIMALAYA_BIN")
                or shutil.which("himalaya")
                or "/usr/local/bin/himalaya")


class HimalayaError(RuntimeError):
    pass


async def run_raw(args: list[str], *, stdin: bytes | None = None,
                  cwd: str | None = None, timeout: float = 45) -> bytes:
    """Run `himalaya <args>`; return stdout bytes. Raise HimalayaError on failure."""
    proc = await asyncio.create_subprocess_exec(
        HIMALAYA_BIN, *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=cwd,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
    except asyncio.TimeoutError as exc:
        try:
            proc.kill()
        except ProcessLookupError:
            pass  # already exited — killing it would mask the timeout as a 500
        # Reap the (now-killed or already-exited) process so its stdout/stderr
        # pipe fds are released. Without this, every timeout leaks descriptors
        # and a long-running server eventually hits EMFILE (too many open files).
        try:
            await proc.wait()
        except Exception:  # noqa: BLE001 - cleanup must never mask the timeout
            pass
        raise HimalayaError(f"himalaya {args[:2]} timed out after {timeout}s") from exc
    if proc.returncode != 0:
        tail = (err or b"").decode(errors="replace").strip()[-400:]
        raise HimalayaError(f"himalaya {args[:2]} failed: {tail or 'unknown error'}")
    return out or b""


async def run_json(args: list[str], *, stdin: bytes | None = None,
                   timeout: float = 45) -> object:
    """Run `himalaya <args> -o json` and decode stdout as JSON."""
    out = await run_raw([*args, "-o", "json"], stdin=stdin, timeout=timeout)
    try:
        return json.loads(out.decode() or "null")
    except json.JSONDecodeError as exc:
        raise HimalayaError(f"himalaya gave non-JSON: {out[:200]!r}") from exc
