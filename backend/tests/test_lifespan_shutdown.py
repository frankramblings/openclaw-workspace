"""Regression: app shutdown must own every task it spawned, not just the three
long-lived ones it always knew about (gateway monitor, reindex, followup
sweeper). Orphaned tasks — the workspace-watch filesystem watcher, per-turn SSE
recorders (`_TURN_TASKS`), fire-and-forget background work (`_BG_TASKS`) —
used to be left for uvicorn's 2s SIGTERM force-close window instead of being
cancelled cleanly by the app itself.

This pins the `_BG_TASKS` half of that contract end-to-end: a task spawned via
`app._spawn` while the app is up must be cancelled by the time the ASGI
lifespan's shutdown phase completes (i.e. by the time `TestClient.__exit__`
returns), and must be dropped from `_BG_TASKS` (the done-callback wiring)."""
import asyncio

from fastapi.testclient import TestClient

from backend import app as app_module


def test_lifespan_cancels_pending_bg_task_on_shutdown():
    with TestClient(app_module.app) as client:
        async def _spawn_forever_task():
            async def _forever():
                await asyncio.sleep(100)
            return app_module._spawn(_forever())

        # Schedule the fake background task on the SAME event loop the app's
        # lifespan runs on (TestClient drives the ASGI app from a portal
        # thread) — asyncio.create_task requires a running loop, and it must
        # be this one for the shutdown code's `_BG_TASKS` cancellation to see
        # and cancel the real task object.
        task = client.portal.call(_spawn_forever_task)
        assert task in app_module._BG_TASKS
        assert not task.done()

    # The `with` block's __exit__ drives the lifespan's shutdown phase to
    # completion (including our `await asyncio.wait_for(asyncio.gather(...))`
    # guard) before returning, so by here the task must be finished.
    assert task.done()
    assert task.cancelled()
    assert task not in app_module._BG_TASKS
