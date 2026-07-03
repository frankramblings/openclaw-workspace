from backend.inbox.sources import entities

NOW = 10 ** 12

PENDING = '''# People Pending Verification

## Automation Suite
```yaml
name: "Automation Suite"
type: person
first_seen_in: "99_Ingest/Processed/gmail_important_latest.jsonl#L13"
verified: false
aliases: []
source_refs:
  - "99_Ingest/Processed/gmail_important_latest.jsonl#L13"
```

## Allie Joel
```yaml
name: "Allie Joel"
type: person
first_seen_in: "99_Ingest/Processed/gmail_important_latest.jsonl#L2"
verified: false
aliases: []
source_refs:
  - "99_Ingest/Processed/gmail_important_latest.jsonl#L2"
```

## Focus Time
```yaml
name: "Focus Time"
type: person
first_seen_in: "x#L1"
verified: false
aliases: []
source_refs:
  - "x#L1"
```
'''


def test_map_items_excludes_verified_and_denylisted():
    overrides = {"allie joel": {"type": "person", "verified": True}}
    denylist = {"focus time"}
    items = entities.map_items(PENDING, overrides, denylist, now_ms=NOW)
    names = [i["title"] for i in items]
    assert names == ["Automation Suite"]  # allie verified, focus denylisted


def test_map_items_shape_and_guess():
    items = entities.map_items(PENDING, {}, set(), now_ms=NOW)
    by_name = {i["title"]: i for i in items}
    auto = by_name["Automation Suite"]
    assert auto["source"] == "entities"
    assert auto["subtitle"] == "guessed: project"
    assert auto["meta"]["canon"] == "automation suite"
    assert auto["meta"]["guessType"] == "project"
    assert "confirm" in auto["actions"] and "not_entity" in auto["actions"]
    assert by_name["Allie Joel"]["meta"]["guessType"] == "person"
    assert auto["ts"] <= NOW and auto["ageHours"] >= 0.0
