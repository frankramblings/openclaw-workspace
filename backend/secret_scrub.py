"""Detect and redact credential-shaped strings from user-provided text.

Scrubs BEFORE persisting to on-disk transcripts and before echoing back in the
UI, so secrets never land in JSONL session files.  The current-turn model call
receives the ORIGINAL text (not scrubbed) so Gary can still act on e.g. a Gmail
app password the user just pasted — but a note is injected so Gary can suggest a
more secure path next time.

Policy:
  - Scrub before PERSIST (event_store / sessions JSONL).
  - Pass original to model for the live turn (so it can act on the credential).
  - Inject a system note into the model prompt when secrets were found.
  - Historical scrub: see bin/scrub-transcripts (separate one-shot script).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Pattern registry
# ---------------------------------------------------------------------------

@dataclass
class _Pattern:
    name: str
    regex: re.Pattern
    label: str   # replacement label, e.g. [REDACTED:gmail-app-password]


# Each pattern is intentionally narrow to avoid false-positives on normal prose.
#
# NOTE: There is deliberately NO Gmail/Google app-password pattern. A real app
# password is 16 random lowercase letters, which is structurally identical to an
# ordinary 16-letter lowercase word ("misunderstanding", "responsibilities") or
# a 16-char identifier. Any regex that catches the credential also redacts normal
# prose, so it fired constantly on everyday messages. The value of catching a
# rarely-pasted 16-char string does not justify mangling ordinary chat, so the
# pattern was removed. The structurally-distinct token patterns below stay.
_PATTERNS: list[_Pattern] = [
    # OpenClaw ops_ / ops_ tokens (internal gateway tokens)
    _Pattern(
        name="openclaw-token",
        regex=re.compile(r'\bops?_[A-Za-z0-9_\-]{20,}\b'),
        label="openclaw-token",
    ),
    # Slack xox* tokens
    _Pattern(
        name="slack-token",
        regex=re.compile(r'\bxox[baprs]-[0-9A-Za-z\-]{10,}\b'),
        label="slack-token",
    ),
    # OpenAI / Anthropic API keys
    _Pattern(
        name="api-key",
        regex=re.compile(r'\b(sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9\-_]{20,})\b'),
        label="api-key",
    ),
    # AWS access key IDs
    _Pattern(
        name="aws-key",
        regex=re.compile(r'\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b'),
        label="aws-key",
    ),
    # LinkedIn auth cookies: start with AQED or li_at= followed by a long token
    _Pattern(
        name="linkedin-cookie",
        regex=re.compile(
            r'(?:'
            r'AQED[A-Za-z0-9_\-+/]{40,}'       # raw AQED... cookie value
            r'|li_at=[A-Za-z0-9_%\-+/]{30,}'    # li_at= form
            r'|AQE[A-Za-z0-9_\-+/]{50,}'        # AQE prefix variant
            r')'
        ),
        label="linkedin-cookie",
    ),
    # Generic Bearer / Authorization header values (very long, high entropy)
    _Pattern(
        name="bearer-token",
        regex=re.compile(r'(?:Bearer\s+|Authorization:\s*Bearer\s+)([A-Za-z0-9_\-+/=.]{40,})'),
        label="bearer-token",
    ),
    # Long hex blobs that look like secrets (32+ hex chars, not embedded in URLs)
    _Pattern(
        name="hex-secret",
        regex=re.compile(r'(?<![/\w])([0-9a-fA-F]{64,})(?![/\w])'),
        label="hex-secret",
    ),
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def scrub(text: str) -> tuple[str, list[str]]:
    """Return (scrubbed_text, list_of_found_labels).

    ``scrubbed_text`` has each matched secret replaced with
    ``[REDACTED:<label>]``.  If no secrets are found, ``scrubbed_text == text``
    and ``found`` is empty.
    """
    if not text:
        return text, []
    found: list[str] = []
    out = text
    for p in _PATTERNS:
        if p.regex.search(out):
            replacement = f"[REDACTED:{p.label}]"
            # For bearer-token the secret is in group 1; replace only that group.
            if p.name == "bearer-token":
                def _repl_bearer(m: re.Match) -> str:
                    return m.group(0).replace(m.group(1), replacement)
                out = p.regex.sub(_repl_bearer, out)
            else:
                out = p.regex.sub(replacement, out)
            if p.label not in found:
                found.append(p.label)
    return out, found


def system_note(found: list[str]) -> str:
    """A short note to inject into the model turn when secrets were found."""
    if not found:
        return ""
    kinds = ", ".join(found)
    return (
        f"[System: The user's message contained what looked like credential(s) "
        f"({kinds}). They have been redacted from the stored transcript. "
        f"For this turn you have the original values so you can act on them, "
        f"but please suggest a more secure path (e.g. a connect-account flow or "
        f"a local secrets file) so the user doesn't need to paste credentials "
        f"into chat again.]"
    )
