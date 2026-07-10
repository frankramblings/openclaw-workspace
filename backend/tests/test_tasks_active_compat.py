"""/api/tasks/active keeps its exact native shape (raw progress.json
payloads) + session_key filter, served from the registry."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import task_registry


@pytest.fixture(autouse=True)
def _fresh():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


@pytest.fixture
def client():
    return TestClient(app_module.app)


def _seed(tid, session_key=None, **native_extra):
    native = {"id": tid, "label": tid, "status": "running", "pct": 33,
              "kind": "render", "updatedAt": "2026-07-10T02:00:00Z",
              **({"sessionKey": session_key} if session_key else {}),
              **native_extra}
    task_registry.upsert(f"taskfile:{tid}", kind="job", source="taskfile",
                         session_key=session_key,
                         extra={"native": native})
    return native


def test_native_payloads_and_filter(client):
    _seed("mine", session_key="agent:main:web-6b3ccecab880")
    _seed("other", session_key="agent:main:web-000000000000")
    body = client.get("/api/tasks/active",
                      params={"session_key": "agent:main:web-6b3ccecab880"}).json()
    assert [t["id"] for t in body["tasks"]] == ["mine"]
    assert body["tasks"][0]["kind"] == "render"   # native field intact


def test_job_source_not_leaked(client):
    task_registry.upsert("job:j1", kind="job", source="job",
                         extra={"native": {"id": "j1", "status": "running"}})
    assert client.get("/api/tasks/active").json()["tasks"] == []
