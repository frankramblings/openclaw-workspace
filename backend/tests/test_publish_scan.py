import subprocess
from pathlib import Path

from backend import config

ROOT = Path(config.REPO_ROOT)


def test_publish_scan_is_clean():
    """Same patterns and exclusions as scripts/prepare-public.sh --check.
    A hit here means a private identifier (name, tailnet host, home path)
    landed in the tracked tree; fix the file, never the pattern."""
    r = subprocess.run(["bash", str(ROOT / "scripts" / "publish-scan.sh")],
                       cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, "publish scan hits:\n" + r.stdout + r.stderr


def test_pattern_file_is_the_single_source():
    pats = (ROOT / "scripts" / "publish-scan-patterns.txt").read_text().split()
    assert "/home/[a-z]" in pats and "/Users/[a-z]" in pats
    prep = (ROOT / "scripts" / "prepare-public.sh").read_text()
    assert "publish-scan.sh" in prep and "PATTERNS='" not in prep
