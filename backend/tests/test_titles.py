"""Unit tests for auto-title pure helpers in app.py."""
from backend.app import _needs_title, _first_chars_title, _sanitize_title


def test_needs_title_placeholders():
    assert _needs_title({"name": "openclaw 1:56:53 PM"}) is True
    assert _needs_title({"name": "gpt-5.5 11:02:09 AM"}) is True
    assert _needs_title({"name": "New chat"}) is True
    assert _needs_title({"name": ""}) is True
    assert _needs_title({"name": "model 14:05:09"}) is True   # 24h, no am/pm


def test_needs_title_real_titles_preserved():
    assert _needs_title({"name": "Jay Acunzo quote timing"}) is False
    assert _needs_title({"name": "Dinner plans Friday"}) is False
    assert _needs_title({"name": "openclaw workspace bugs"}) is False  # no trailing time


def test_first_chars_title():
    assert _first_chars_title("Dinner Friday?") == "Dinner Friday?"
    long = "when did meg say the jay acunzo thing happened exactly i forget"
    out = _first_chars_title(long)
    assert out.startswith("when did meg say") and out.endswith("…") and len(out) <= 43
    # only the first line
    assert _first_chars_title("First line\nsecond line") == "First line"


def test_sanitize_title():
    assert _sanitize_title('"Jay Acunzo Quote Timing"') == "Jay Acunzo Quote Timing"
    assert _sanitize_title("Title: Foo bar") == "Foo bar"
    assert _sanitize_title("Dinner plans.\nblah") == "Dinner plans"
    assert _sanitize_title("") == ""
    assert len(_sanitize_title("x" * 200)) <= 60


def test_titler_runs_on_the_configured_cheap_model(monkeypatch):
    # A throwaway 6-word title must never run as a full gpt-5.5 thinking turn
    # racing the user's real first message (the audit's biggest turn tax).
    import asyncio

    from backend import app as app_module
    from backend import config

    captured = {}

    async def fake_stream_turn(prompt, session_key=None, model_ref=None, **kw):
        captured["model_ref"] = model_ref
        yield 'data: {"delta": "Tiny Title"}\n\n'

    monkeypatch.setattr(app_module.bridge, "stream_turn", fake_stream_turn)
    title = asyncio.run(app_module._generate_ai_title("hello there"))
    assert captured["model_ref"] == config.TITLE_MODEL
    assert title == "Tiny Title"
