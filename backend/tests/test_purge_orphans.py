"""Unit tests for the orphan-session sweep's pure filter (the script isn't a
package module, so load it by path)."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "purge_orphan_sessions",
    Path(__file__).resolve().parents[2] / "scripts" / "purge_orphan_sessions.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
find_orphans = _mod.find_orphans

NOW = 1_800_000_000_000
OLD = NOW - 2 * 86_400_000  # 2 days ago — past the recency guard


def _sess(key, updated=OLD):
    return {"key": key, "updatedAt": updated}


def test_keeps_referenced_protected_recent_and_non_web():
    sessions = [
        _sess("agent:main:web-aaa"),        # referenced in .data → keep
        _sess("agent:main:web-bbb"),        # orphan → delete
        _sess("agent:main:web-titler"),     # protected → keep
        _sess("agent:main:main"),           # not a web thread → keep
        _sess("agent:main:web-ccc", NOW),   # active <24h → keep (research guard)
    ]
    blob = '{"sessionKey": "agent:main:web-aaa"}'
    out = find_orphans(sessions, blob, "agent:main:web",
                       {"agent:main:web", "agent:main:web-titler"}, NOW)
    assert out == ["agent:main:web-bbb"]


def test_research_threads_match_the_web_prefix():
    out = find_orphans([_sess("agent:main:web-research-xyz")],
                       "", "agent:main:web", set(), NOW)
    assert out == ["agent:main:web-research-xyz"]


def test_bare_web_key_is_not_a_per_chat_thread():
    # The shared key has no "-" suffix; the prefix filter must skip it even
    # when it's not in the protected set.
    out = find_orphans([_sess("agent:main:web")], "", "agent:main:web", set(), NOW)
    assert out == []
