"""push.with_thread_url stamps a thread deep link onto push payloads so a
notification tap opens the thread it is about (spec §5)."""
from backend import push, sessions_store


def _mk():
    return sessions_store.create(name="t", model=None, endpoint_url=None,
                                 endpoint_id=None, speed=None)


def test_spa_id_gets_url():
    rec = _mk()
    out = push.with_thread_url({"title": "x", "session_id": rec["id"]})
    assert out["url"] == f"/#chat/{rec['id']}"


def test_gateway_key_resolves_to_spa_id():
    rec = _mk()
    out = push.with_thread_url({"session_id": rec["sessionKey"]})
    assert out["url"] == f"/#chat/{rec['id']}"


def test_unknown_or_missing_session_leaves_payload_alone():
    assert push.with_thread_url({"session_id": "nope"}) == {"session_id": "nope"}
    assert push.with_thread_url({"title": "x"}) == {"title": "x"}
    assert push.with_thread_url({"session_id": ""}) == {"session_id": ""}


def test_existing_url_is_kept_and_input_not_mutated():
    rec = _mk()
    src = {"session_id": rec["id"], "url": "/#inbox"}
    out = push.with_thread_url(src)
    assert out["url"] == "/#inbox"
    assert src == {"session_id": rec["id"], "url": "/#inbox"}
