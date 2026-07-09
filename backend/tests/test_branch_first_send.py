"""First send into a branched session prepends the pending branch-context
preamble to the outgoing text; the pending context is consumed (deleted) so
every subsequent send passes through unchanged."""
import json

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, config, sessions_store, websearch
from backend.app import app


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")


@pytest.fixture
def _isolated_branch_context_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCLAW_BRANCH_CONTEXT_DIR", str(tmp_path / "branch_context"))


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _events(sse_text: str) -> list:
    out = []
    for line in sse_text.splitlines():
        if not line.startswith("data: "):
            continue
        body = line[6:]
        try:
            out.append(json.loads(body))
        except ValueError:
            out.append(body)
    return out


@pytest.mark.anyio
async def test_compose_helper_prepends_once_then_passes_through(_isolated_branch_context_dir):
    from backend import branch_context

    sess = sessions_store.create(name="branched", model=None)
    try:
        branch_context.write(
            sess["id"], "src-1",
            [{"id": "m1", "role": "user", "text": "hello"}],
            "For context, this conversation was branched from an earlier thread.",
        )

        outgoing = await app_module._compose_outgoing_for_session(sess["id"], "next")
        assert outgoing.startswith("For context")
        assert outgoing.endswith("next")

        outgoing2 = await app_module._compose_outgoing_for_session(sess["id"], "again")
        assert outgoing2 == "again"
    finally:
        sessions_store.delete(sess["id"])


@pytest.mark.anyio
async def test_compose_helper_passthrough_when_no_pending_context(_isolated_branch_context_dir):
    outgoing = await app_module._compose_outgoing_for_session("no-such-session", "hi")
    assert outgoing == "hi"


def test_chat_stream_prepends_preamble_on_first_send(_isolated_branch_context_dir, monkeypatch):
    from backend import branch_context

    sess = sessions_store.create(name="branched", model=None)
    branch_context.write(
        sess["id"], "src-1",
        [{"id": "m1", "role": "user", "text": "hello"}],
        "For context, this conversation was branched from an earlier thread.",
    )

    sent = []

    async def fake_stream_turn(message, session_key=None, model_ref=None, run_info=None, **kwargs):
        sent.append(message)
        if run_info is not None:
            run_info["sessionKey"] = session_key
        return
        yield  # pragma: no cover - make this an async generator

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)

    client = TestClient(app)
    try:
        r1 = client.post("/api/chat_stream", data={"message": "next", "session": sess["id"]})
        assert r1.status_code == 200
        _events(r1.text)
        assert sent, "bridge.stream_turn was never called"
        # Other per-turn prefixes (e.g. terminal-control notes) may still lead
        # the composed text; what matters is the branch preamble was spliced
        # in ahead of the user's own text, and the raw text still lands last.
        assert "For context" in sent[0]
        assert sent[0].index("For context") < sent[0].index("Frank: next")
        assert sent[0].endswith("next")

        r2 = client.post("/api/chat_stream", data={"message": "again", "session": sess["id"]})
        assert r2.status_code == 200
        _events(r2.text)
        # Context was consumed on the first send — the second send carries no
        # preamble and no synthetic "Frank: " prefix.
        assert "For context" not in sent[1]
        assert "Frank: again" not in sent[1]
        assert sent[1].endswith("again")
    finally:
        sessions_store.delete(sess["id"])


def test_chat_stream_websearch_on_first_send_keeps_branch_preamble(
        _isolated_branch_context_dir, monkeypatch):
    """Regression for the Task 4 review Critical: when the composer's web-search
    toggle is on and the first send after a branch returns results,
    websearch.context_block must build on the already-composed brain_message
    (branch preamble + user text), not the raw `message` param — otherwise the
    one-shot preamble (already consumed/deleted by branch_context) is silently
    dropped forever."""
    from backend import branch_context

    sess = sessions_store.create(name="branched", model=None)
    branch_context.write(
        sess["id"], "src-1",
        [{"id": "m1", "role": "user", "text": "hello"}],
        "For context, this conversation was branched from an earlier thread.",
    )

    sent = []

    async def fake_stream_turn(message, session_key=None, model_ref=None, run_info=None, **kwargs):
        sent.append(message)
        if run_info is not None:
            run_info["sessionKey"] = session_key
        return
        yield  # pragma: no cover - make this an async generator

    async def fake_search(query, count=5):
        return [{"title": "Result", "url": "https://example.com", "snippet": "snippet"}]

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(websearch, "search", fake_search)
    monkeypatch.setattr(websearch, "load_settings",
                         lambda: {"search_provider": "serpapi", "search_result_count": 5})

    client = TestClient(app)
    try:
        r1 = client.post("/api/chat_stream", data={
            "message": "next", "session": sess["id"], "use_web": "1",
        })
        assert r1.status_code == 200
        _events(r1.text)
        assert sent, "bridge.stream_turn was never called"
        outgoing = sent[0]
        # Both the branch preamble and the web-search context block must
        # survive onto the same outgoing brain_message.
        assert "For context" in outgoing
        assert "Web search results" in outgoing
        assert "https://example.com" in outgoing
        # context_block wraps the already-composed brain_message: the search
        # block leads, and the branch preamble + user text follow intact
        # after the "User message:" marker — nothing was dropped.
        assert outgoing.index("Web search results") < outgoing.index("For context")
        assert outgoing.endswith("Frank: next")
    finally:
        sessions_store.delete(sess["id"])
