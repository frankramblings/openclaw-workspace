"""Task 18 step 1 (parity-gate instrumentation): the /classic route must keep
serving index-classic.html byte-for-byte (no behavior change) AND log a single
INFO line on every hit, so usage can be tracked via
`journalctl --user -u openclaw-workspace | grep -c "classic UI served"` during
the soak period ahead of eventual retirement (see docs/plans/2026-07-09-
iceberg-remainder.md, Task 18). The log line must contain the word "classic"
so it's easy to grep."""
import logging

import pytest
from fastapi.testclient import TestClient

from backend.app import app


@pytest.fixture()
def client():
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


class TestClassicRouteInstrumentation:
    def test_classic_route_still_returns_200_html(self, client):
        r = client.get("/classic")
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]

    def test_classic_route_logs_one_info_line_mentioning_classic(self, client, caplog):
        with caplog.at_level(logging.INFO, logger="backend.app"):
            client.get("/classic")
        records = [rec for rec in caplog.records
                   if rec.name == "backend.app" and "classic" in rec.getMessage().lower()]
        assert len(records) == 1
        assert records[0].levelno == logging.INFO
