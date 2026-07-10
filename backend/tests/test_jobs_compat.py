"""/api/jobs must serve the SAME native record shape it always did, now read
from the registry instead of re-globbing the directory per request. The
overlay and the /jobs/live page depend on these exact fields."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import jobs as jobs_module
from backend import task_registry


@pytest.fixture(autouse=True)
def _fresh():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


@pytest.fixture
def client():
    return TestClient(app_module.app)


def _seed(jid, state="running", **native_extra):
    native = {"id": jid, "label": f"label-{jid}", "status": "running",
              "pct": 12.5, "startedAt": "2026-07-10T01:00:00Z", **native_extra}
    task_registry.upsert(f"job:{jid}", kind="job", source="job",
                         label=native["label"], state=state,
                         pct=native.get("pct"),
                         extra={"native": native, "updated_epoch": 0})
    return native


def test_jobs_serves_native_shape(client):
    native = _seed("render566", bytesDone=1024, bytesTotal=4096)
    body = client.get("/api/jobs").json()
    assert len(body["jobs"]) == 1
    got = body["jobs"][0]
    assert got["id"] == "render566"
    assert got["bytesDone"] == 1024            # arbitrary native fields survive
    assert "_updatedEpoch" not in got          # private fields stripped


def test_stalled_state_injects_stalled_field(client):
    _seed("quiet", state="stalled")
    got = client.get("/api/jobs").json()["jobs"][0]
    assert got.get("stalled")


def test_running_sorts_before_terminal(client):
    _seed("b-done", state="done", status="done")
    _seed("a-run", state="running")
    ids = [j["id"] for j in client.get("/api/jobs").json()["jobs"]]
    assert ids[0] == "a-run"


def test_taskfile_source_not_leaked_into_jobs(client):
    task_registry.upsert("taskfile:t1", kind="job", source="taskfile",
                         extra={"native": {"id": "t1", "status": "running"}})
    assert client.get("/api/jobs").json()["jobs"] == []


def test_terminal_job_past_60s_window_dropped(client):
    """Amendment (Task 3 review): the legacy /api/jobs dropped terminal jobs
    after 60s (RETAIN_SECS), well before the registry's own 300s retention
    (RETAIN_TERMINAL_S) would prune them. _read_all must re-apply that
    tighter window using the registry record's own `updated` timestamp."""
    _seed("old", state="done", status="done")
    task_registry._TASKS["job:old"]["updated"] -= 61_000  # older than RETAIN_SECS (60s)
    body = client.get("/api/jobs").json()
    assert body["jobs"] == []
