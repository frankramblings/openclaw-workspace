"""A walk that forgets to prune would take minutes on Gary's workspace. Guard:
40k files, half under pruned dirs, must scan in under 2 s."""
import time

from backend import changes


def test_forty_thousand_files_scan_under_two_seconds(tmp_path):
    root = tmp_path / "ws"
    for d in range(40):
        (root / f"d{d}").mkdir(parents=True)
        for i in range(500):
            open(root / f"d{d}" / f"f{i}.txt", "w").close()
    for d in range(40):
        (root / ".venv-x" / f"p{d}").mkdir(parents=True)
        for i in range(500):
            open(root / ".venv-x" / f"p{d}" / f"m{i}.py", "w").close()
    cfg = dict(changes.DEFAULT_CONFIG)
    cfg["roots"] = [str(root)]
    t0 = time.monotonic()
    got = changes.scan_root(str(root), cfg)
    dt = time.monotonic() - t0
    assert len(got) == 20000
    assert dt < 2.0, f"scan took {dt:.2f}s"
