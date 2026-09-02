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
