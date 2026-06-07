"""Unit tests for the gateway monitor's state machine (the pure handlers)."""
from backend import monitor


def setup_function(_fn):
    monitor._state.update(state="down", since=0.0,
                          updateAvailable=None, shutdownReason=None)
    monitor._health_cache.update(at=0.0, agents=None, sessionCount=None)


def test_shutdown_event_marks_restarting():
    monitor.handle_connected()
    monitor.handle_event("shutdown", {"reason": "restart"})
    assert monitor.current_state() == "restarting"
    assert monitor._state["shutdownReason"] == "restart"


def test_disconnect_after_shutdown_stays_restarting():
    monitor.handle_connected()
    monitor.handle_event("shutdown", {"reason": "restart"})
    monitor.handle_disconnect()
    assert monitor.current_state() == "restarting"


def test_unannounced_disconnect_is_down():
    monitor.handle_connected()
    monitor.handle_disconnect()
    assert monitor.current_state() == "down"


def test_reconnect_clears_restarting_and_reason():
    monitor.handle_event("shutdown", {"reason": "restart"})
    monitor.handle_connected()
    assert monitor.current_state() == "ok"
    assert monitor._state["shutdownReason"] is None


def test_update_available_is_cached():
    monitor.handle_event("update-available", {"version": "2026.6.2"})
    assert monitor._state["updateAvailable"]["version"] == "2026.6.2"
