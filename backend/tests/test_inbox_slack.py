"""Unit tests for the slack collector's pure parts (CSV parse + scoring)."""
from backend.inbox.sources import slack

NOW = 10**12
ISO = "2026-06-05T10:00:00Z"
ROW = ('1780670000.123456,U0123ABCD,taylor,Taylor Corrado,#general,,'
       '"hey @frank can you look at the player bug?",' + ISO + ',0,')
DM_ROW = ('1780670001.654321,U0456EFGH,jed,Jed L,D024MDM,,'
          '"quick question about quotas",' + ISO + ',0,')


def test_parse_csv_lines_extracts_fields():
    rows = slack.parse_csv_lines(ROW)
    assert len(rows) == 1
    r = rows[0]
    assert r["msgId"] == "1780670000.123456"
    assert r["realName"] == "Taylor Corrado"
    assert r["channel"] == "#general"
    assert r["text"] == "hey @frank can you look at the player bug?"


def test_low_signal_rows_are_dropped():
    assert slack.is_low_signal({"userName": "asana", "text": "task updated"})
    assert slack.is_low_signal({"userName": "x", "text": ":tada: :tada:"})
    assert slack.is_low_signal({"userName": "x", "text": "ok"})
    assert not slack.is_low_signal({"userName": "x", "text": "can you review this?"})


def test_map_items_scores_mentions_and_dms():
    unreads = slack.parse_csv_lines(DM_ROW)
    mentions = slack.parse_csv_lines(ROW)
    for m in unreads + mentions:
        m["time"] = NOW - 3600_000  # 1h old -> +2 recency
    items = slack.map_items(unreads, mentions, handle_map={}, now_ms=NOW)
    by_id = {i["id"]: i for i in items}
    assert by_id["1780670000.123456"]["score"] == 5 + 2        # mention + <2h
    assert by_id["1780670001.654321"]["score"] == 2 + 2 + 1    # unread + <2h + DM
    assert by_id["1780670000.123456"]["actions"] == ["mark_read", "dismiss", "snooze"]


def test_channel_url_built_from_handle_map():
    mentions = slack.parse_csv_lines(ROW)
    mentions[0]["time"] = NOW
    items = slack.map_items([], mentions, handle_map={"#general": "C0GEN"}, now_ms=NOW)
    assert items[0]["meta"]["url"] == \
        "https://example.slack.com/archives/C0GEN/p1780670000123456"
