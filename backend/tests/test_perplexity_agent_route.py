from __future__ import annotations

import json
import textwrap

from fastapi.testclient import TestClient

from backend import perplexity_agent
from backend.app import app


def test_perplexity_agent_route_calls_sidecar_cli(tmp_path, monkeypatch):
    fake = tmp_path / "fake-pplx"
    fake.write_text(textwrap.dedent("""\
        #!/bin/sh
        printf '{"answer":"PPLX_ROUTE_OK","model":"perplexity-auto","rounds":1,"trace":[]}'
        """))
    fake.chmod(0o755)
    monkeypatch.setattr(perplexity_agent, "_PPLX_CLI", fake)

    res = TestClient(app).post("/api/perplexity-agent/ask", json={
        "prompt": "reply ok",
        "max_rounds": 1,
    })

    assert res.status_code == 200
    assert res.json()["answer"] == "PPLX_ROUTE_OK"


def test_perplexity_agent_route_rejects_blank_prompt():
    res = TestClient(app).post("/api/perplexity-agent/ask", json={"prompt": "   "})

    assert res.status_code == 400
    assert "prompt" in res.json()["detail"].lower()


def test_perplexity_agent_route_surfaces_sidecar_failure(tmp_path, monkeypatch):
    fake = tmp_path / "fake-pplx"
    fake.write_text("#!/bin/sh\necho broken >&2\nexit 7\n")
    fake.chmod(0o755)
    monkeypatch.setattr(perplexity_agent, "_PPLX_CLI", fake)

    res = TestClient(app).post("/api/perplexity-agent/ask", json={"prompt": "hi"})

    assert res.status_code == 502
    assert "broken" in res.json()["detail"]
