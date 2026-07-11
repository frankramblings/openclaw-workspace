"""task_registry: the canonical background-task map every progress surface
reads. Merge-by-id must not clobber known values with unknowns, terminal
records must age out, subscribers must see every upsert, and volatile-source
tasks must survive a restart only as an honest 'interrupted' record."""
import asyncio

from backend import config, task_registry


def setup_function(_fn):
    task_registry.reset_for_tests()


def test_upsert_creates_and_merges_without_clobbering():
    t1 = task_registry.upsert("job:x", kind="job", source="job",
                              label="render 566", pct=10.0, detail="warming up")
    assert t1["created"] == t1["updated"]
    t2 = task_registry.upsert("job:x", kind="job", source="job",
                              pct=55.0, detail="frame 300/540")
    assert t2["label"] == "render 566"        # not clobbered by default ""
    assert t2["pct"] == 55.0
    assert t2["updated"] >= t2["created"]
    assert task_registry.get("job:x")["detail"] == "frame 300/540"


def test_list_orders_running_first_and_prunes_old_terminal():
    task_registry.upsert("job:done-old", kind="job", source="job", state="done")
    task_registry.upsert("job:run", kind="job", source="job", state="running")
    # Age the terminal record past retention.
    rec = task_registry.get("job:done-old")
    rec_updated = rec["updated"] - (task_registry.RETAIN_TERMINAL_S * 1000 + 1000)
    task_registry._TASKS["job:done-old"]["updated"] = rec_updated
    out = task_registry.list_tasks()
    assert [t["id"] for t in out] == ["job:run"]


def test_list_filters_by_session_and_source():
    task_registry.upsert("followup:a", kind="followup", source="followup",
                         session_key="agent:main:web-aaa")
    task_registry.upsert("job:b", kind="job", source="job")
    assert [t["id"] for t in task_registry.list_tasks(session_key="agent:main:web-aaa")] == ["followup:a"]
    assert [t["id"] for t in task_registry.list_tasks(source="job")] == ["job:b"]


def test_subscribers_receive_upserts():
    async def main():
        q = task_registry.subscribe()
        try:
            task_registry.upsert("research:r1", kind="research", source="research",
                                 label="deep dive")
            ev = q.get_nowait()
            assert ev["id"] == "research:r1" and ev["state"] == "running"
        finally:
            task_registry.unsubscribe(q)
    asyncio.run(main())


def test_volatile_ledger_and_boot_sweep(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    task_registry.upsert("research:r2", kind="research", source="research",
                         label="survey", volatile=True)
    # Simulate restart: in-memory gone, ledger file remains.
    task_registry.reset_for_tests()
    moved = task_registry.sweep_boot()
    assert [t["id"] for t in moved] == ["research:r2"]
    rec = task_registry.get("research:r2")
    assert rec["state"] == "interrupted" and rec["label"] == "survey"
    # Ledger cleared: second sweep is a no-op.
    assert task_registry.sweep_boot() == []


def test_terminal_upsert_clears_volatile_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    task_registry.upsert("research:r3", kind="research", source="research", volatile=True)
    # Producers pass volatile=True on EVERY upsert for a volatile source —
    # the registry decides write (running) vs clear (terminal) by state.
    task_registry.upsert("research:r3", kind="research", source="research",
                         state="done", volatile=True)
    task_registry.reset_for_tests()
    assert task_registry.sweep_boot() == []   # done task left nothing behind


def test_volatile_running_ticks_write_ledger_once(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    task_registry.upsert("research:r4", kind="research", source="research",
                         label="survey", volatile=True)
    ledger = tmp_path / "tasks_volatile.json"
    mtime1 = ledger.stat().st_mtime_ns
    task_registry.upsert("research:r4", kind="research", source="research",
                         label="survey", pct=50.0, volatile=True)
    assert ledger.stat().st_mtime_ns == mtime1   # unchanged entry → no rewrite


def test_ledger_keeps_session_key_across_ticks(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    task_registry.upsert("research:r5", kind="research", source="research",
                         label="survey", session_key="agent:main:web-aaa",
                         volatile=True)
    ledger = tmp_path / "tasks_volatile.json"
    mtime1 = ledger.stat().st_mtime_ns
    # Second tick omits session_key (merge contract: None doesn't clobber).
    task_registry.upsert("research:r5", kind="research", source="research",
                         pct=50.0, volatile=True)
    assert ledger.stat().st_mtime_ns == mtime1     # no spurious rewrite
    task_registry.reset_for_tests()
    moved = task_registry.sweep_boot()
    assert moved[0]["session_key"] == "agent:main:web-aaa"


def test_outbound_records_do_not_share_extra():
    task_registry.upsert("job:iso", kind="job", source="job",
                         extra={"native": {"id": "iso"}})
    got = task_registry.get("job:iso")
    got["extra"]["native"] = "corrupted"
    assert task_registry.get("job:iso")["extra"]["native"] == {"id": "iso"}


def test_remove_drops_silently():
    async def main():
        task_registry.upsert("job:gone", kind="job", source="job")
        q = task_registry.subscribe()
        try:
            task_registry.remove("job:gone")
            assert task_registry.get("job:gone") is None
            assert q.qsize() == 0             # no event for removals
        finally:
            task_registry.unsubscribe(q)
    asyncio.run(main())


def test_stalled_subscriber_is_dropped_not_unbounded():
    async def main():
        q = task_registry.subscribe()
        try:
            for i in range(task_registry.SUBSCRIBER_QUEUE_MAX + 10):
                task_registry.upsert(f"job:flood{i}", kind="job", source="job")
            assert q.qsize() == task_registry.SUBSCRIBER_QUEUE_MAX
            # The overflowing subscriber was dropped — later upserts don't reach it…
            task_registry.upsert("job:after", kind="job", source="job")
            assert q.qsize() == task_registry.SUBSCRIBER_QUEUE_MAX
            # …and a healthy subscriber still receives events.
            q2 = task_registry.subscribe()
            try:
                task_registry.upsert("job:healthy", kind="job", source="job")
                assert q2.qsize() == 1
            finally:
                task_registry.unsubscribe(q2)
        finally:
            task_registry.unsubscribe(q)

    import asyncio
    asyncio.run(main())
