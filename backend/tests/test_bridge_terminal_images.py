"""chat_stream merges pending terminal images into the turn's vision attachments
and marks them consumed (one-turn delivery)."""
import base64

import pytest

from backend import app as appmod
from backend import terminals


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(terminals.config, "DATA_DIR", tmp_path / "data", raising=False)
    # Real .attachments dir with a tiny PNG so read_bytes/mime succeed.
    from backend.uploads import ATTACH_DIR
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
    (ATTACH_DIR / "merge1.png").write_bytes(png)


def test_pending_terminal_image_becomes_attachment_block_and_consumed():
    terminals.register_attachment("mk", "merge1.png", name="m.png", mime="image/png")
    blocks = appmod._terminal_attachments("mk")
    assert len(blocks) == 1
    b = blocks[0]
    assert b["type"] == "image" and b["mimeType"] == "image/png" and b["fileName"] == "merge1.png"
    assert base64.b64decode(b["content"])  # valid base64
    # Consumed → no longer pending, but still resolvable.
    assert appmod._terminal_attachments("mk") == []
    assert terminals.resolve_attachment("mk", "[m.png]")


def test_missing_file_is_skipped_not_fatal():
    terminals.register_attachment("mk2", "gone.png", name="g.png", mime="image/png")
    assert appmod._terminal_attachments("mk2") == []
