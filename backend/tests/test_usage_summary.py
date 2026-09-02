import pytest
from fastapi.testclient import TestClient

from backend import bridge
from backend.app import app

SAMPLE = {
    "updatedAt": 1788308075045, "days": 8,
    "daily": [
        {"date": "2026-08-27", "input": 100, "output": 20, "cacheRead": 5, "cacheWrite": 3,
         "totalTokens": 128, "totalCost": 1.1, "missingCostEntries": 146},
        {"date": "2026-08-28", "input": 50, "output": 10, "cacheRead": 0, "cacheWrite": 0,
         "totalTokens": 60, "totalCost": 0.5, "missingCostEntries": 0},
    ],
    "totals": {"input": 150, "output": 30, "cacheRead": 5, "cacheWrite": 3,
               "totalTokens": 188, "totalCost": 1.6, "missingCostEntries": 146},
    "cacheStatus": "warm",
}


@pytest.fixture
def client():
    return TestClient(app)


def test_relays_seven_days(client, monkeypatch):
    seen = {}

    async def fake_call(method, params=None, timeout=30.0):
        seen["method"], seen["params"] = method, params
        return SAMPLE

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    r = client.get("/api/usage/summary?days=7")
    assert r.status_code == 200
    body = r.json()
    assert seen == {"method": "usage.cost", "params": {"days": 7}}
    assert body["ok"] is True and body["days"] == 7
    assert body["daily"][1]["date"] == "2026-08-28"
    assert body["totals"]["totalTokens"] == 188
    assert body["costed"] is False            # 146 uncosted entries → no dollars
    assert body["updatedAt"] == 1788308075045


def test_costed_when_every_entry_priced(client, monkeypatch):
    priced = dict(SAMPLE, totals=dict(SAMPLE["totals"], missingCostEntries=0))

    async def fake_call(method, params=None, timeout=30.0):
        return priced

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    assert client.get("/api/usage/summary?days=30").json()["costed"] is True


def test_rejects_other_windows(client):
    assert client.get("/api/usage/summary?days=9").status_code == 400
    assert client.get("/api/usage/summary?days=abc").status_code == 400


def test_gateway_failure_is_502(client, monkeypatch):
    async def boom(method, params=None, timeout=30.0):
        raise RuntimeError("usage.cost failed")

    monkeypatch.setattr(bridge, "gateway_call", boom)
    r = client.get("/api/usage/summary?days=7")
    assert r.status_code == 502
    assert r.json()["reason"] == "gateway_error"


def test_malformed_totals_and_daily_degrade_gracefully(client, monkeypatch):
    malformed = dict(SAMPLE, totals=[1, 2, 3], daily=5)

    async def fake_call(method, params=None, timeout=30.0):
        return malformed

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    r = client.get("/api/usage/summary?days=7")
    assert r.status_code == 200
    body = r.json()
    assert body["totals"] == {}
    assert body["daily"] == []
    assert body["costed"] is False


def test_fresh_reflects_the_gateway_cache_status(client, monkeypatch):
    """A mid-refresh ledger must be reported as not fresh so the panel stops
    claiming the tokens are complete."""
    async def stale(method, params=None, timeout=30.0):
        return dict(SAMPLE, cacheStatus={"status": "refreshing"})

    monkeypatch.setattr(bridge, "gateway_call", stale)
    assert client.get("/api/usage/summary?days=7").json()["fresh"] is False

    async def fresh(method, params=None, timeout=30.0):
        return dict(SAMPLE, cacheStatus={"status": "fresh"})

    monkeypatch.setattr(bridge, "gateway_call", fresh)
    assert client.get("/api/usage/summary?days=7").json()["fresh"] is True

    async def silent(method, params=None, timeout=30.0):
        return SAMPLE

    monkeypatch.setattr(bridge, "gateway_call", silent)
    assert client.get("/api/usage/summary?days=7").json()["fresh"] is True


def test_boolean_totals_are_not_numbers(client, monkeypatch):
    async def fake_call(method, params=None, timeout=30.0):
        return dict(SAMPLE, totals={"missingCostEntries": False, "totalTokens": True})

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    # totalTokens=True must coerce to 0, so the response is not "costed".
    assert client.get("/api/usage/summary?days=7").json()["costed"] is False


def test_non_numeric_missing_cost_entries_is_not_costed(client, monkeypatch):
    payload = dict(SAMPLE, totals={"missingCostEntries": "abc"})

    async def fake_call(method, params=None, timeout=30.0):
        return payload

    monkeypatch.setattr(bridge, "gateway_call", fake_call)
    r = client.get("/api/usage/summary?days=7")
    assert r.status_code == 200
    assert r.json()["costed"] is False
