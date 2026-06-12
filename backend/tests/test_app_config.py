from fastapi.testclient import TestClient

from backend.app import app


def test_config_includes_workspace_root():
    d = TestClient(app).get("/api/config").json()
    assert "workspace_root" in d and isinstance(d["workspace_root"], str) and d["workspace_root"]
