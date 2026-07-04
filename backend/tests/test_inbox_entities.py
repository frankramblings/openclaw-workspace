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


PENDING_WITH_ALIASES = '''# People Pending Verification

## Jayde Powell
```yaml
name: "Jayde Powell"
type: person
first_seen_in: "99_Ingest/Processed/gmail_important_latest.jsonl#L2"
verified: false
aliases:
  - "JP"
  - "J.P."
source_refs:
  - "99_Ingest/Processed/gmail_important_latest.jsonl#L2"
  - "99_Ingest/Processed/gmail_important_latest.jsonl#L5"
```
'''


PENDING_WITH_DATE_JUNK = '''# People Pending Verification

## Mon Jul
```yaml
name: "Mon Jul"
type: person
first_seen_in: "x#L1"
verified: false
aliases: []
source_refs:
  - "x#L1"
```

## Thu Dec
```yaml
name: "Thu Dec"
type: person
first_seen_in: "x#L2"
verified: false
aliases: []
source_refs:
  - "x#L2"
```

## Erica Griffith
```yaml
name: "Erica Griffith"
type: person
first_seen_in: "x#L3"
verified: false
aliases: []
source_refs:
  - "x#L3"
```
'''


def test_map_items_drops_date_fragments():
    # Day/month scraps ("Mon Jul", "Thu Dec") are not entities and must not
    # surface at all; a real name in the same file still comes through.
    items = entities.map_items(PENDING_WITH_DATE_JUNK, {}, set(), now_ms=NOW)
    names = [i["title"] for i in items]
    assert names == ["Erica Griffith"]


def test_evidence_scoped_to_source_refs():
    items = entities.map_items(PENDING_WITH_ALIASES, {}, set(), now_ms=NOW)
    assert len(items) == 1
    item = items[0]
    assert item["title"] == "Jayde Powell"
    evidence = item["meta"]["evidence"]
    assert "JP" not in evidence
    assert "J.P." not in evidence
    assert "99_Ingest/Processed/gmail_important_latest.jsonl#L2" in evidence
    assert "99_Ingest/Processed/gmail_important_latest.jsonl#L5" in evidence
    assert len(evidence) == 2
