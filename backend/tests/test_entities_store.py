import json

import pytest

from backend.inbox import entities_store as es


@pytest.fixture
def base(tmp_path):
    (tmp_path / "People_Pending_Overrides.json").write_text('{\n  "allie joel": {\n    "type": "person",\n    "verified": true\n  }\n}\n')
    (tmp_path / "Entity_Denylist.md").write_text("# Entity Denylist\n\n- Focus Time\n")
    return tmp_path


def test_canon_name():
    assert es.canon_name("  Allie Joel  ") == "allie joel"
    assert es.canon_name("Daycare Drop- ") == "daycare drop"
    assert es.canon_name("Automation Suite") == "automation suite"


def test_load_overrides_and_denylist(base):
    ov = es.load_overrides(base)
    assert ov["allie joel"] == {"type": "person", "verified": True}
    dl = es.load_denylist(base)
    assert "focus time" in dl


def test_set_override_returns_prior_and_persists(base):
    prior = es.set_override("automation suite", "project", True, base=base)
    assert prior is None  # didn't exist before
    ov = json.loads((base / "People_Pending_Overrides.json").read_text())
    assert ov["automation suite"] == {"type": "project", "verified": True}
    # keys stay sorted
    assert list(ov.keys()) == sorted(ov.keys())


def test_set_override_restore_round_trips(base):
    prior = es.set_override("allie joel", "org", False, base=base)
    assert prior == {"type": "person", "verified": True}
    es.restore_override("allie joel", prior, base=base)
    ov = es.load_overrides(base)
    assert ov["allie joel"] == {"type": "person", "verified": True}


def test_restore_none_deletes_key(base):
    es.set_override("impact report", "event", True, base=base)
    es.restore_override("impact report", None, base=base)
    assert "impact report" not in es.load_overrides(base)


def test_set_override_corrupt_file_raises_and_leaves_file_untouched(base):
    path = base / "People_Pending_Overrides.json"
    path.write_text("{not valid json")
    with pytest.raises(json.JSONDecodeError):
        es.set_override("automation suite", "project", True, base=base)
    # the corrupt file must not have been silently replaced.
    assert path.read_text() == "{not valid json"


def test_set_override_missing_file_still_works(base):
    path = base / "People_Pending_Overrides.json"
    path.unlink()
    prior = es.set_override("automation suite", "project", True, base=base)
    assert prior is None
    ov = json.loads(path.read_text())
    assert ov["automation suite"] == {"type": "project", "verified": True}


def test_append_denylist_idempotent(base):
    assert es.append_denylist("Meeting Summary", base=base) is True
    assert es.append_denylist("meeting summary", base=base) is False  # canon dupe
    body = (base / "Entity_Denylist.md").read_text()
    assert body.count("Meeting Summary") == 1
    es.remove_denylist("Meeting Summary", base=base)
    assert "meeting summary" not in es.load_denylist(base)
