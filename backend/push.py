"""Web push notifications: VAPID key management, subscription store, sender, unseen tracking.

Gary's async work reaches Frank's phone via web push. The module lazily imports
pywebpush (optional dep) so absent → push degrades gracefully. Subscriptions and
unseen counts persist atomically under .data/push/ using the same JSON pattern
as followup.py. VAPID keypair is generated once and reused; send() iterates all
subscriptions in a thread executor (blocking I/O), prunes on 404/410, and never
raises — all errors downgrade to a `{"sent": 0, "reason": ...}` response shape.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from pathlib import Path

from . import config, fsutil, sessions_store

_log = logging.getLogger(__name__)

_LOCK = threading.Lock()


def _push_dir() -> Path:
    return config.DATA_DIR / "push"


def _vapid_file() -> Path:
    return _push_dir() / "vapid.json"


def _subscriptions_file() -> Path:
    return _push_dir() / "subscriptions.json"


def _unseen_file() -> Path:
    return _push_dir() / "unseen.json"


def supported() -> bool:
    """Return True if pywebpush can be imported, False if it's absent."""
    try:
        import pywebpush  # noqa: F401
        return True
    except ImportError:
        return False


def _ensure_vapid_keys() -> tuple[str, str]:
    """Load or generate VAPID keypair, returning (private_key_pem, public_key_b64url).

    Persists in .data/push/vapid.json with restrictive perms (0600) so the
    private key never leaks. Private key is stored as PEM (for webpush),
    public key as base64url X962 uncompressed point (for browser subscription).
    """
    vapid_path = _vapid_file()
    if vapid_path.exists():
        data = fsutil.load_json_guarded(vapid_path, None, logger=_log)
        if data and "private" in data and "public" in data:
            return data["private"], data["public"]

    # Generate new keypair using py_vapid
    try:
        import base64
        import tempfile
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid02

        vapid = Vapid02()
        vapid.generate_keys()

        # Export private key as PEM (webpush needs this)
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            temp_key_path = f.name
        try:
            vapid.save_key(temp_key_path)
            private_pem = Path(temp_key_path).read_text()
        finally:
            os.unlink(temp_key_path)

        # Export public key as base64url X962 uncompressed point
        public_key_obj = vapid.public_key
        public_bytes = public_key_obj.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint
        )
        public_b64 = base64.urlsafe_b64encode(public_bytes).decode().rstrip("=")

        # Persist
        _push_dir().mkdir(parents=True, exist_ok=True)
        data = {"private": private_pem, "public": public_b64}
        fsutil.atomic_write_json(vapid_path, data)
        os.chmod(vapid_path, 0o600)

        return private_pem, public_b64
    except Exception as e:
        _log.error("failed to generate VAPID keys: %s", e, exc_info=True)
        raise


def ensure_keys() -> None:
    """Ensure VAPID keypair exists, creating it if missing."""
    with _LOCK:
        try:
            _ensure_vapid_keys()
        except Exception as e:
            _log.error("ensure_keys failed: %s", e, exc_info=True)
            raise


def public_key() -> str | None:
    """Return the base64url-encoded public VAPID key for browser subscription,
    or None if unsupported."""
    if not supported():
        return None
    try:
        with _LOCK:
            _, public_b64 = _ensure_vapid_keys()
            return public_b64
    except Exception as e:
        _log.error("public_key failed: %s", e)
        return None


def add_subscription(sub: dict) -> None:
    """Add (or deduplicate) a subscription by endpoint."""
    if not sub or "endpoint" not in sub:
        return
    with _LOCK:
        data = fsutil.load_json_guarded(_subscriptions_file(), {"subscriptions": []}, logger=_log)
        subs = data.setdefault("subscriptions", [])
        # Remove any existing sub with the same endpoint
        subs[:] = [s for s in subs if s.get("endpoint") != sub["endpoint"]]
        # Append the new one
        subs.append(sub)
        _push_dir().mkdir(parents=True, exist_ok=True)
        fsutil.atomic_write_json(_subscriptions_file(), data)


def remove_subscription(endpoint: str) -> None:
    """Remove a subscription by endpoint."""
    if not endpoint:
        return
    with _LOCK:
        data = fsutil.load_json_guarded(_subscriptions_file(), {"subscriptions": []}, logger=_log)
        subs = data.setdefault("subscriptions", [])
        subs[:] = [s for s in subs if s.get("endpoint") != endpoint]
        _push_dir().mkdir(parents=True, exist_ok=True)
        fsutil.atomic_write_json(_subscriptions_file(), data)


def subscription_count() -> int:
    """Return the number of stored subscriptions."""
    with _LOCK:
        data = fsutil.load_json_guarded(_subscriptions_file(), {"subscriptions": []}, logger=_log)
        return len(data.get("subscriptions", []))


def with_thread_url(payload: dict) -> dict:
    """Return a copy of `payload` with `url` set to the thread's deep link
    ("/#chat/<spa id>") when `session_id` names a known session (SPA id or
    gateway key). A payload that already carries `url`, or names no session,
    comes back unchanged. Pure: never mutates the input."""
    out = dict(payload or {})
    if out.get("url"):
        return out
    sid = str(out.get("session_id") or "").strip()
    if not sid:
        return out
    spa = sessions_store.id_for_session_key(sid)
    if spa:
        out["url"] = f"/#chat/{spa}"
    return out


async def send(payload: dict) -> dict:
    """Send push notification to all subscriptions.

    Runs webpush in a thread executor (blocking I/O). Prunes subscriptions on
    404/410. Returns {"sent": n, "pruned": n} on success, or
    {"sent": 0, "reason": ...} when degraded. Never raises.
    """
    payload = with_thread_url(payload)
    if not supported():
        return {"sent": 0, "reason": "push not supported"}

    try:
        with _LOCK:
            data = fsutil.load_json_guarded(_subscriptions_file(), {"subscriptions": []}, logger=_log)
            subs = data.get("subscriptions", [])

        if not subs:
            return {"sent": 0, "reason": "no subscriptions"}

        loop = asyncio.get_running_loop()
        sent_count = 0
        pruned_endpoints = []

        def _send_to_sub(sub: dict) -> bool | None:
            """Send to one subscription. Returns True (sent), False (prune), None (skip)."""
            if not sub or "endpoint" not in sub:
                return None
            try:
                import pywebpush

                # Get VAPID keys
                try:
                    private_pem, public_b64 = _ensure_vapid_keys()
                except Exception:
                    return None

                # Send via webpush
                payload_json = json.dumps(payload)
                pywebpush.webpush(
                    sub["endpoint"],
                    payload_json.encode("utf-8"),
                    vapid_private_key=private_pem,
                    vapid_public_key=public_b64,
                    vapid_claims={"sub": "mailto:frank@localhost"}
                )
                # webpush raises on failure, so if we reach here it succeeded
                return True
            except Exception as e:
                # Check if it's a 404/410 (subscription gone)
                err_str = str(e).lower()
                if "404" in err_str or "410" in err_str:
                    return False  # prune
                _log.debug("webpush to %s failed: %s", sub.get("endpoint", "?"), e)
                return None  # skip (don't prune, assume transient)

        # Send to all subs in the thread pool
        for sub in subs:
            try:
                result = await loop.run_in_executor(None, _send_to_sub, sub)
                if result is True:
                    sent_count += 1
                elif result is False:
                    pruned_endpoints.append(sub.get("endpoint"))
            except Exception as e:
                _log.debug("send executor error for %s: %s", sub.get("endpoint", "?"), e)

        # Prune failed subscriptions
        if pruned_endpoints:
            with _LOCK:
                for endpoint in pruned_endpoints:
                    remove_subscription(endpoint)

        return {"sent": sent_count, "pruned": len(pruned_endpoints)}
    except Exception as e:
        _log.error("send failed: %s", e, exc_info=True)
        return {"sent": 0, "reason": f"send error: {e}"}


def mark_unseen(pid: str, session_id: str) -> int:
    """Mark a followup as unseen (create entry). Returns the new unseen count."""
    if not pid or not session_id:
        return unseen_count()
    with _LOCK:
        data = fsutil.load_json_guarded(_unseen_file(), {"followups": {}}, logger=_log)
        followups = data.setdefault("followups", {})
        followups[pid] = session_id
        _push_dir().mkdir(parents=True, exist_ok=True)
        fsutil.atomic_write_json(_unseen_file(), data)
        return len(followups)


def ack_session(session_id: str) -> int:
    """Acknowledge all unseen followups for a session (remove them). Returns the new unseen count."""
    if not session_id:
        return unseen_count()
    with _LOCK:
        data = fsutil.load_json_guarded(_unseen_file(), {"followups": {}}, logger=_log)
        followups = data.setdefault("followups", {})
        # Remove all entries where session_id matches
        followups = {k: v for k, v in followups.items() if v != session_id}
        data["followups"] = followups
        _push_dir().mkdir(parents=True, exist_ok=True)
        fsutil.atomic_write_json(_unseen_file(), data)
        return len(followups)


def ack_all() -> int:
    """Acknowledge all unseen followups. Returns the new unseen count (0)."""
    with _LOCK:
        data = {"followups": {}}
        _push_dir().mkdir(parents=True, exist_ok=True)
        fsutil.atomic_write_json(_unseen_file(), data)
        return 0


def unseen_count() -> int:
    """Return the number of unseen followups."""
    with _LOCK:
        data = fsutil.load_json_guarded(_unseen_file(), {"followups": {}}, logger=_log)
        return len(data.get("followups", {}))
