"""Tests for backend.push module: VAPID keys, subscriptions, unseen tracking, send()."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from backend import push, config, fsutil
from backend.app import app

pytest_plugins = ("pytest_asyncio",)


@pytest.fixture
def mock_data_dir(tmp_path, monkeypatch):
    """Point DATA_DIR to a temp directory for isolation."""
    test_data_dir = tmp_path / "data"
    monkeypatch.setattr(config, "DATA_DIR", test_data_dir)
    return test_data_dir


@pytest.fixture
def client(mock_data_dir):
    """FastAPI TestClient for endpoint testing."""
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture
def clear_push_module():
    """Clear push module state between tests (in case any global state persists)."""
    yield
    # After test, nothing to clear (we use mocks + fresh files via mock_data_dir)


class TestVapidKeys:
    """Test VAPID keypair generation and persistence."""

    def test_ensure_keys_creates_keypair(self, mock_data_dir):
        """ensure_keys() creates .data/push/vapid.json if missing."""
        push.ensure_keys()
        vapid_path = mock_data_dir / "push" / "vapid.json"
        assert vapid_path.exists()
        data = json.loads(vapid_path.read_text())
        assert "private" in data
        assert "public" in data
        assert len(data["private"]) > 0
        assert len(data["public"]) > 0

    def test_ensure_keys_idempotent(self, mock_data_dir):
        """ensure_keys() on existing keys returns the same pair."""
        push.ensure_keys()
        vapid_path = mock_data_dir / "push" / "vapid.json"
        first = json.loads(vapid_path.read_text())

        push.ensure_keys()
        second = json.loads(vapid_path.read_text())

        assert first == second

    def test_public_key_returns_key(self, mock_data_dir):
        """public_key() returns the public VAPID key string."""
        push.ensure_keys()
        pk = push.public_key()
        assert pk is not None
        assert isinstance(pk, str)
        assert len(pk) > 0

    def test_public_key_degraded_when_unsupported(self, monkeypatch):
        """public_key() returns None if pywebpush is not available."""
        monkeypatch.setattr(push, "supported", lambda: False)
        result = push.public_key()
        assert result is None


class TestSupported:
    """Test supported() detection."""

    def test_supported_true_when_pywebpush_available(self):
        """supported() returns True if pywebpush can be imported."""
        # pywebpush is pre-installed in .venv, so this should be True
        assert push.supported() is True


class TestSubscriptions:
    """Test subscription store operations."""

    def test_add_subscription(self, mock_data_dir):
        """add_subscription() stores a subscription."""
        sub = {"endpoint": "https://example.com/push/1", "keys": {"p256dh": "...", "auth": "..."}}
        push.add_subscription(sub)
        assert push.subscription_count() == 1

    def test_add_subscription_dedupe(self, mock_data_dir):
        """add_subscription() replaces if endpoint already exists."""
        sub1 = {"endpoint": "https://example.com/push/1", "keys": {"p256dh": "a", "auth": "b"}}
        sub2 = {"endpoint": "https://example.com/push/1", "keys": {"p256dh": "x", "auth": "y"}}

        push.add_subscription(sub1)
        push.add_subscription(sub2)

        assert push.subscription_count() == 1
        subs_file = mock_data_dir / "push" / "subscriptions.json"
        data = json.loads(subs_file.read_text())
        assert data["subscriptions"][0]["keys"]["p256dh"] == "x"

    def test_add_subscription_ignores_empty(self, mock_data_dir):
        """add_subscription() with empty sub or missing endpoint is a no-op."""
        push.add_subscription({})
        push.add_subscription({"keys": {}})
        assert push.subscription_count() == 0

    def test_remove_subscription(self, mock_data_dir):
        """remove_subscription() by endpoint."""
        sub1 = {"endpoint": "https://example.com/push/1"}
        sub2 = {"endpoint": "https://example.com/push/2"}

        push.add_subscription(sub1)
        push.add_subscription(sub2)
        assert push.subscription_count() == 2

        push.remove_subscription("https://example.com/push/1")
        assert push.subscription_count() == 1

    def test_subscription_count_empty_file(self, mock_data_dir):
        """subscription_count() returns 0 for missing/empty file."""
        assert push.subscription_count() == 0


class TestUnseenTracking:
    """Test unseen followup tracking."""

    def test_mark_unseen(self, mock_data_dir):
        """mark_unseen() creates an unseen entry, returns new count."""
        count = push.mark_unseen("promise-1", "session-1")
        assert count == 1

        count = push.mark_unseen("promise-2", "session-1")
        assert count == 2

    def test_mark_unseen_ignores_empty(self, mock_data_dir):
        """mark_unseen() with empty pid/session_id is a no-op."""
        count = push.mark_unseen("", "session-1")
        assert count == 0
        count = push.mark_unseen("promise-1", "")
        assert count == 0

    def test_ack_session(self, mock_data_dir):
        """ack_session() removes all unseen for that session."""
        push.mark_unseen("p1", "session-1")
        push.mark_unseen("p2", "session-1")
        push.mark_unseen("p3", "session-2")

        count = push.ack_session("session-1")
        assert count == 1  # only p3 remains

        # Verify p3 is still there
        unseen_file = mock_data_dir / "push" / "unseen.json"
        data = json.loads(unseen_file.read_text())
        assert data["followups"].get("p3") == "session-2"

    def test_ack_all(self, mock_data_dir):
        """ack_all() removes all unseen entries."""
        push.mark_unseen("p1", "session-1")
        push.mark_unseen("p2", "session-1")
        push.mark_unseen("p3", "session-2")

        count = push.ack_all()
        assert count == 0
        assert push.unseen_count() == 0

    def test_unseen_count(self, mock_data_dir):
        """unseen_count() returns the total unseen count."""
        assert push.unseen_count() == 0
        push.mark_unseen("p1", "session-1")
        assert push.unseen_count() == 1
        push.mark_unseen("p2", "session-2")
        assert push.unseen_count() == 2


class TestSend:
    """Test push notification sending."""

    def test_send_sync_no_subscriptions(self, mock_data_dir):
        """send() with no subscriptions returns {"sent": 0, "reason": ...} (sync test)."""
        # Run the async function in a new event loop
        result = asyncio.run(push.send({"title": "test"}))
        assert result.get("sent") == 0
        assert "no subscriptions" in result.get("reason", "").lower()

    @pytest.mark.asyncio
    async def test_send_degraded_when_unsupported(self, mock_data_dir):
        """send() returns {"sent": 0, "reason": ...} when push is unsupported."""
        # Mock supported to return False
        with mock.patch("backend.push.supported", return_value=False):
            result = await push.send({"title": "test"})
            assert result.get("sent") == 0
            assert "not supported" in result.get("reason", "").lower()


class TestCorruptionRecovery:
    """Test handling of corrupt/missing JSON files."""

    def test_add_subscription_with_corrupt_file(self, mock_data_dir):
        """add_subscription() recovers from corrupt subscriptions.json."""
        subs_file = mock_data_dir / "push" / "subscriptions.json"
        subs_file.parent.mkdir(parents=True, exist_ok=True)
        subs_file.write_text("{invalid json")

        # This should recover by treating as empty and creating a fresh file
        sub = {"endpoint": "https://example.com/push/1"}
        push.add_subscription(sub)

        # File should now be valid
        assert push.subscription_count() == 1

    def test_mark_unseen_with_corrupt_file(self, mock_data_dir):
        """mark_unseen() recovers from corrupt unseen.json."""
        unseen_file = mock_data_dir / "push" / "unseen.json"
        unseen_file.parent.mkdir(parents=True, exist_ok=True)
        unseen_file.write_text("{bad json")

        # Should recover
        count = push.mark_unseen("p1", "session-1")
        assert count == 1


class TestFollowupPushNotification:
    """Test push notifications on followup completion."""

    def test_mark_completed_sends_push(self, mock_data_dir, monkeypatch):
        """mark() on completed transition marks unseen and spawns push send."""
        from backend import followup, app

        # Mock push.send to capture payloads
        sent_payloads = []

        async def mock_send(payload):
            sent_payloads.append(payload)
            return {"sent": 1, "pruned": 0}

        monkeypatch.setattr(push, "send", mock_send)

        # Create a promise
        promise = followup.create_promise("session-1", "session-key-1", "test task", 0)
        pid = promise["id"]

        # Mark it completed
        result = followup.mark(pid, "completed", exit_code=0, duration_s=5.3)
        assert result is not None
        assert result["state"] == "completed"

        # Check that unseen count increased
        assert push.unseen_count() == 1

        # Note: we can't easily test that spawn was called in sync tests, but we can
        # verify the mark() function completes without error and unseen is marked

    def test_mark_failed_sends_push(self, mock_data_dir):
        """mark() on failed transition marks unseen."""
        from backend import followup

        promise = followup.create_promise("session-1", "session-key-1", "test task", 0)
        pid = promise["id"]

        # Mark it failed
        result = followup.mark(pid, "failed", error="test error")
        assert result is not None
        assert result["state"] == "failed"

        # Check that unseen count increased
        assert push.unseen_count() == 1

    def test_mark_overdue_sends_push(self, mock_data_dir):
        """mark() on overdue transition marks unseen."""
        from backend import followup

        promise = followup.create_promise("session-1", "session-key-1", "test task", 0)
        pid = promise["id"]

        # Mark it overdue
        result = followup.mark(pid, "overdue", error="test overdue")
        assert result is not None
        assert result["state"] == "overdue"

        # Check that unseen count increased
        assert push.unseen_count() == 1

    def test_no_push_on_mark_if_unsupported(self, mock_data_dir, monkeypatch):
        """mark() skips push if push is not supported (degraded)."""
        from backend import followup

        monkeypatch.setattr(push, "supported", lambda: False)

        promise = followup.create_promise("session-1", "session-key-1", "test task", 0)
        pid = promise["id"]

        # Mark it completed
        result = followup.mark(pid, "completed", exit_code=0, duration_s=5.3)
        assert result is not None

        # Unseen count should still be 0 (push disabled)
        assert push.unseen_count() == 0


class TestHttpEndpoints:
    """Test /api/push/* HTTP endpoints."""

    def test_status_endpoint_supported_true(self, client, mock_data_dir):
        """GET /api/push/status returns supported=true (pywebpush installed)."""
        response = client.get("/api/push/status")
        assert response.status_code == 200
        data = response.json()
        assert data["supported"] is True
        assert data["publicKey"] is not None
        assert isinstance(data["subscriptions"], int)
        assert isinstance(data["unseen"], int)

    def test_status_endpoint_supported_false(self, client, mock_data_dir):
        """GET /api/push/status returns supported=false when degraded."""
        with mock.patch("backend.push.supported", return_value=False):
            response = client.get("/api/push/status")
            assert response.status_code == 200
            data = response.json()
            assert data["supported"] is False
            assert data["publicKey"] is None

    def test_subscribe_endpoint_valid(self, client, mock_data_dir):
        """POST /api/push/subscribe with valid body succeeds."""
        sub = {
            "endpoint": "https://example.com/push/1",
            "keys": {"p256dh": "abc", "auth": "def"}
        }
        response = client.post("/api/push/subscribe", json=sub)
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        assert push.subscription_count() == 1

    def test_subscribe_endpoint_missing_endpoint(self, client, mock_data_dir):
        """POST /api/push/subscribe without endpoint → 400."""
        sub = {"keys": {"p256dh": "abc", "auth": "def"}}
        response = client.post("/api/push/subscribe", json=sub)
        assert response.status_code == 400
        assert "error" in response.json()

    def test_subscribe_endpoint_missing_keys(self, client, mock_data_dir):
        """POST /api/push/subscribe without keys → 400."""
        sub = {"endpoint": "https://example.com/push/1"}
        response = client.post("/api/push/subscribe", json=sub)
        assert response.status_code == 400
        assert "error" in response.json()

    def test_unsubscribe_endpoint_valid(self, client, mock_data_dir):
        """POST /api/push/unsubscribe removes a subscription."""
        # Add a subscription first
        sub = {
            "endpoint": "https://example.com/push/1",
            "keys": {"p256dh": "abc", "auth": "def"}
        }
        client.post("/api/push/subscribe", json=sub)
        assert push.subscription_count() == 1

        # Unsubscribe
        response = client.post("/api/push/unsubscribe", json={"endpoint": "https://example.com/push/1"})
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        assert push.subscription_count() == 0

    def test_unsubscribe_endpoint_missing_endpoint(self, client, mock_data_dir):
        """POST /api/push/unsubscribe without endpoint → 400."""
        response = client.post("/api/push/unsubscribe", json={})
        assert response.status_code == 400
        assert "error" in response.json()

    def test_ack_endpoint_session(self, client, mock_data_dir):
        """POST /api/push/ack with session_id acks that session."""
        # Mark some unseen followups
        push.mark_unseen("p1", "session-1")
        push.mark_unseen("p2", "session-2")
        assert push.unseen_count() == 2

        # Ack session-1
        response = client.post("/api/push/ack", json={"session_id": "session-1"})
        assert response.status_code == 200
        data = response.json()
        assert data["unseen"] == 1  # only p2 remains

    def test_ack_endpoint_all(self, client, mock_data_dir):
        """POST /api/push/ack with all=true acks everything."""
        # Mark some unseen followups
        push.mark_unseen("p1", "session-1")
        push.mark_unseen("p2", "session-2")
        assert push.unseen_count() == 2

        # Ack all
        response = client.post("/api/push/ack", json={"all": True})
        assert response.status_code == 200
        data = response.json()
        assert data["unseen"] == 0

    def test_ack_endpoint_missing_session_and_all(self, client, mock_data_dir):
        """POST /api/push/ack without session_id or all → 400."""
        response = client.post("/api/push/ack", json={})
        assert response.status_code == 400
        assert "error" in response.json()

    def test_status_after_subscribe(self, client, mock_data_dir):
        """Status endpoint reflects subscription count after subscribe."""
        response = client.get("/api/push/status")
        initial = response.json()
        assert initial["subscriptions"] == 0

        # Subscribe
        sub = {
            "endpoint": "https://example.com/push/1",
            "keys": {"p256dh": "abc", "auth": "def"}
        }
        client.post("/api/push/subscribe", json=sub)

        # Check status again
        response = client.get("/api/push/status")
        updated = response.json()
        assert updated["subscriptions"] == 1
