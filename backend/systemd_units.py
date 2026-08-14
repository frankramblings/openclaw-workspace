"""Read-only adapter over `systemctl --user`.

Every systemctl call and every byte of its output parsing lives here, so the
follower that consumes it can be tested against plain dictionaries instead of
a live init system. Nothing in this module ever mutates a unit: the verbs are
`list-units` and `show`, and that is the whole vocabulary.

Failure never raises, deliberately. If systemd is unreachable — no user bus,
no `systemctl` on PATH, a timeout — neither function here raises, because the
spec's degradation rule for this observer is "systemd unavailable → follower
off; units fall back to the descendant scan". A follower that cannot see a
unit must report nothing, never guess.

`show` collapses that failure to {}, same as "no units matched" — it has no
question that hinges on telling the two apart. `list_active` does NOT: it
returns None on failure, distinct from [] ("systemd answered; nothing is
active"), because the follower's closing loop treats those two answers
oppositely. Read [] as "everything I'm tracking really did stop" is fine —
that is what the answer means. Read None that way and a systemctl timeout
would close every unit the follower is tracking as if it had confirmed each
one gone, on precisely the review finding that is not confirmation at all.
"""
from __future__ import annotations

import logging
import subprocess

log = logging.getLogger(__name__)

# What the follower needs, and why each one:
#   Id                  — the key `show` blocks are mapped by
#   Transient           — yes iff systemd-run created it, i.e. it is a JOB and
#                         not installed infrastructure (the whole filter)
#   InvocationID        — unique per START, so a re-run of a deterministically
#                         named unit is a new row rather than the old one
#   ActiveState/SubState— alive or not
#   ExecMainPID         — the process to hang a descendant subtree on; 0 once
#                         the unit has exited
#   ExecMainStatus      — the real exit code
#   Result              — success / exit-code / signal / timeout / oom-kill
#   Description         — systemd-run sets this to the command line
#   ActiveEnterTimestamp— when it really started, which survives a backend
#                         restart in a way our own first-seen clock does not
SHOW_PROPS = ("Id", "Transient", "InvocationID", "ActiveState", "SubState",
              "ExecMainPID", "ExecMainStatus", "Result", "Description",
              "ActiveEnterTimestamp")

TIMEOUT_S = 5.0


def _run(argv: list[str]) -> str | None:
    """Default runner: stdout, or None on any failure whatsoever -- distinct
    from a legitimate empty stdout, which is real output ("nothing matched")
    rather than "could not be asked at all"."""
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              timeout=TIMEOUT_S)
    except (OSError, subprocess.SubprocessError):
        log.warning("systemd_units: %s failed", " ".join(argv[:3]), exc_info=True)
        return None
    return proc.stdout


def _guarded(run, argv: list[str]) -> str | None:
    """An injected runner is test code and may raise; the contract with our
    caller is still silence-on-failure, expressed as None rather than "" so a
    caller that needs to tell "systemd could not be asked at all" apart from
    "systemd answered and there was nothing" can do so. `list_active` relies
    on that distinction (a failed pass must not read as "nothing active" and
    close every unit it was tracking); `show` has no equivalent question to
    ask and just collapses None back to an empty result, same as before."""
    try:
        return (run or _run)(argv)
    except Exception:  # noqa: BLE001 - the follower must never break the poll
        log.warning("systemd_units: runner raised for %s",
                    " ".join(argv[:3]), exc_info=True)
        return None


def parse_show(text: str) -> list[dict]:
    """`systemctl show A B` emits one blank-line-separated block per unit.
    Values are taken verbatim after the FIRST '=' — a Description holds a whole
    command line and routinely contains more."""
    blocks: list[dict] = []
    current: dict = {}
    for line in (text or "").splitlines():
        if not line.strip():
            if current:
                blocks.append(current)
                current = {}
            continue
        key, sep, value = line.partition("=")
        if not sep or not key:
            continue
        current[key] = value
    if current:
        blocks.append(current)
    return blocks


def list_active(run=None) -> list[str] | None:
    """Names of active .service units, or None if systemd could not be asked
    at all this pass (subprocess failure/timeout). 4 ms on this box.

    None is deliberately distinct from []: an empty list is systemd's real
    answer ("nothing is active", which the follower can act on -- e.g. close
    everything it was tracking); None is no information whatsoever, and a
    caller that treats it as "nothing active" would close every unit it
    holds on a mere systemctl hiccup rather than leaving them for the next
    pass."""
    out = _guarded(run, ["systemctl", "--user", "list-units", "--type=service",
                         "--state=active", "--no-legend", "--plain"])
    if out is None:
        return None
    names = []
    for line in out.splitlines():
        parts = line.split()
        if parts and parts[0].endswith(".service"):
            names.append(parts[0])
    return names


def show(units: list[str], run=None) -> dict[str, dict]:
    """unit name -> properties. One fork for the whole list."""
    if not units:
        return {}
    argv = ["systemctl", "--user", "show", *units]
    for prop in SHOW_PROPS:
        argv += ["-p", prop]
    out = _guarded(run, argv) or ""
    return {b["Id"]: b for b in parse_show(out) if b.get("Id")}
