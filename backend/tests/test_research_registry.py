"""Research jobs are volatile (in-memory engine): every _publish mirrors to
the registry with volatile=True so a mid-run restart surfaces an honest
'interrupted' record instead of the job silently vanishing."""
import pytest

from backend import config, research, task_registry


@pytest.fixture(autouse=True)
def _fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


def _job():
    return research.Job(id="r_test1", query="how do sea slugs steal chloroplasts",
                        settings={})


def test_publish_mirrors_running():
    job = _job()
    research._publish(job, phase="searching", pct=20)
    rec = task_registry.get("research:r_test1")
    assert rec["kind"] == "research" and rec["state"] == "running"
    assert rec["pct"] == 20 and rec["detail"] == "searching"
    assert "sea slugs" in rec["label"]


def test_publish_is_volatile_for_boot_sweep(monkeypatch):
    job = _job()
    research._publish(job, phase="reading")
    task_registry.reset_for_tests()
    moved = task_registry.sweep_boot()
    assert [t["id"] for t in moved] == ["research:r_test1"]


def test_finish_done_and_error():
    ok = _job()
    research._finish(ok, "done")
    assert task_registry.get("research:r_test1")["state"] == "done"
    bad = research.Job(id="r_test2", query="q", settings={})
    research._finish(bad, "error", error="provider 500")
    rec = task_registry.get("research:r_test2")
    assert rec["state"] == "failed" and rec["error"] == "provider 500"
