"""Unit tests for the globe-toggle field synonym.

The SPA's vestigial chat/agent mode changes the FIELD NAME the web toggle
posts: `use_web` in chat mode, `allow_web_search` in agent mode. The backend
must honor both — agent mode silently lost web search before this.
"""
from backend.app import _wants_web


def test_chat_mode_field():
    assert _wants_web("true", "") is True
    assert _wants_web("1", "") is True
    assert _wants_web("on", "") is True


def test_agent_mode_field():
    assert _wants_web("", "true") is True
    assert _wants_web("", "yes") is True


def test_neither_or_falsy():
    assert _wants_web("", "") is False
    assert _wants_web("false", "") is False
    assert _wants_web("", "0") is False
