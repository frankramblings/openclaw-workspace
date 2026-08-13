"""/api/tasks + /api/tasks/stream — the one feed every progress surface
consumes. Snapshot must reflect the registry; the stream must emit the
snapshot first, then per-upsert deltas, with no gap between them."""
import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import task_registry, tasks_route


@pytest.fixture(autouse=True)
def _fresh_registry():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


@pytest.fixture
def client():
    return TestClient(app_module.app)


def test_snapshot_lists_registry(client):
    task_registry.upsert("job:x", kind="job", source="job", label="render")
    body = client.get("/api/tasks").json()
    assert [t["id"] for t in body["tasks"]] == ["job:x"]


def test_snapshot_session_filter(client):
    task_registry.upsert("followup:a", kind="followup", source="followup",
                         session_key="agent:main:web-aaa")
    task_registry.upsert("job:b", kind="job", source="job")
    body = client.get("/api/tasks", params={"session": "agent:main:web-aaa"}).json()
    assert [t["id"] for t in body["tasks"]] == ["followup:a"]


def test_stream_snapshot_then_delta():
    task_registry.upsert("job:x", kind="job", source="job", label="render")

    async def main():
        gen = tasks_route._stream_gen()
        first = await gen.__anext__()
        assert '"type":"tasks.snapshot"' in first and '"job:x"' in first
        task_registry.upsert("job:x", kind="job", source="job", pct=50.0)
        second = await asyncio.wait_for(gen.__anext__(), timeout=2)
        assert '"type":"task.update"' in second
        body = json.loads(second[len("data: "):])
        assert body["task"]["pct"] == 50.0
        await gen.aclose()

    asyncio.run(main())


def test_stream_frames_a_removal_as_task_remove():
    # Final review, Critical 1: the merge drops a LIVE row, and the client
    # can only learn that from a frame of its own — task.update cannot say
    # "gone", and a snapshot only arrives on connect / visibility resume.
    task_registry.upsert("taskfile:moved", kind="job", source="taskfile")

    async def main():
        gen = tasks_route._stream_gen()
        await gen.__anext__()                       # the snapshot frame
        task_registry.remove("taskfile:moved", notify=True)
        frame = await asyncio.wait_for(gen.__anext__(), timeout=2)
        assert json.loads(frame[len("data: "):]) == {
            "type": "task.remove", "id": "taskfile:moved"}
        await gen.aclose()

    asyncio.run(main())


def test_stream_ends_after_drop(monkeypatch):
    monkeypatch.setattr(tasks_route, "_KEEPALIVE_S", 0.01)

    async def main():
        gen = tasks_route._stream_gen()
        first = await gen.__anext__()
        assert '"type":"tasks.snapshot"' in first
        # Find this generator's queue and drop it the way _fanout would.
        q = next(iter(task_registry._SUBSCRIBERS))
        task_registry._SUBSCRIBERS.discard(q)
        with pytest.raises(StopAsyncIteration):
            # Drain a few frames: the gen must END (not keepalive forever).
            for _ in range(5):
                await asyncio.wait_for(gen.__anext__(), timeout=1)

    asyncio.run(main())
