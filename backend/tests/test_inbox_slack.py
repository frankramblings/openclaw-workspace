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


def test_map_items_drops_non_mention_channel_unreads():
    # firehose noise: an unread in a channel where I'm not mentioned -> dropped
    noise = slack.parse_csv_lines(
        '1780670003.000300,U0999XYZ,bob,Bob R,#random,,'
        '"just chatting about lunch",' + ISO + ',0,')
    noise[0]["time"] = NOW
    assert slack.map_items(noise, [], handle_map={}, now_ms=NOW) == []


def test_map_items_keeps_dms_and_mentions():
    dm = slack.parse_csv_lines(DM_ROW)        # D024MDM -> direct message
    mention = slack.parse_csv_lines(ROW)      # #general but arrives via mentions
    for m in dm + mention:
        m["time"] = NOW
    items = slack.map_items(dm, mention, handle_map={}, now_ms=NOW)
    ids = {i["id"] for i in items}
    assert "1780670001.654321" in ids         # DM kept
    assert "1780670000.123456" in ids         # @mention kept


def test_is_signal_keeps_usergroup_mention_for_my_groups():
    # a channel unread that @-mentions a usergroup I'm in is signal (C2)
    msg = {"kind": "unread", "channel": "#tech-weeks",
           "text": "@Demand Gen want to connect today"}
    assert slack.is_signal(msg, {"demand gen"})
    assert not slack.is_signal(msg, {"design team"})   # not my group -> dropped


def test_is_signal_without_groups_is_mentions_and_dms_only():
    msg = {"kind": "unread", "channel": "#x", "text": "@Demand Gen hi"}
    assert not slack.is_signal(msg)                     # no groups passed
    assert slack.is_signal({"kind": "mention", "channel": "#x", "text": "hi"})
    assert slack.is_signal({"kind": "unread", "channel": "D9", "text": "dm"})


def test_map_items_keeps_usergroup_mention_via_my_groups():
    noise = slack.parse_csv_lines(
        '1780670004.000400,U0999XYZ,bob,Bob R,#tech-weeks,,'
        '"@Demand Gen quick sync?",' + ISO + ',0,')
    noise[0]["time"] = NOW
    # without my groups -> dropped; with -> kept
    assert slack.map_items(noise, [], handle_map={}, now_ms=NOW) == []
    items = slack.map_items(noise, [], handle_map={}, now_ms=NOW,
                            my_groups={"demand gen"})
    assert len(items) == 1
    assert items[0]["meta"]["kind"] == "usergroup"


def test_channel_url_built_from_handle_map():
    mentions = slack.parse_csv_lines(ROW)
    mentions[0]["time"] = NOW
    items = slack.map_items([], mentions, handle_map={"#general": "C0GEN"}, now_ms=NOW)
    assert items[0]["meta"]["url"] == \
        "https://example.slack.com/archives/C0GEN/p1780670000123456"


# --- name resolution (#5) ------------------------------------------------

USERS = [
    {"id": "U3B6KNK8B", "name": "chrisb", "real_name": "Chris Baxter",
     "profile": {"display_name": "Chris B"}},
    {"id": "U0123ABCD", "name": "taylor", "real_name": "Taylor Corrado",
     "profile": {"display_name": ""}},  # no display name -> fall back to real_name
]


def test_build_user_map_prefers_display_then_real_then_name():
    m = slack.build_user_map(USERS)
    assert m["U3B6KNK8B"] == "Chris B"
    assert m["U0123ABCD"] == "Taylor Corrado"


def test_resolve_refs_replaces_bare_id():
    m = {"U3B6KNK8B": "Chris B"}
    assert slack.resolve_slack_refs("Hey U3B6KNK8B question", m) == \
        "Hey @Chris B question"


def test_resolve_refs_replaces_angle_token_and_label_form():
    m = {"U3B6KNK8B": "Chris B"}
    assert slack.resolve_slack_refs("Hey <@U3B6KNK8B> question", m) == \
        "Hey @Chris B question"
    # <@ID|label> keeps the explicit label Slack already rendered
    assert slack.resolve_slack_refs("ping <@U3B6KNK8B|chris> now", m) == \
        "ping @chris now"


def test_resolve_refs_leaves_unknown_ids_untouched():
    # an unknown id (not in the map) must not be mangled into a fake @
    assert slack.resolve_slack_refs("ref UNKNOWN99 here", {}) == "ref UNKNOWN99 here"


def test_resolve_refs_glued_id_then_name():
    # The Slack MCP renders mentions as <id><DisplayName> glued together with no
    # delimiter (e.g. "U01GEK1BJ8KFrank"). Strip the id, keep the name -> "@Frank".
    m = {"U01GEK1BJ8K": "Frank"}
    assert slack.resolve_slack_refs("FYI U01GEK1BJ8KFrank ok", m) == "FYI @Frank ok"


def test_resolve_refs_glued_multiword_name():
    m = {"U01PNU8428N": "Taylor Corrado"}
    assert slack.resolve_slack_refs("cc U01PNU8428NTaylor Corrado now", m) == \
        "cc @Taylor Corrado now"


def test_resolve_refs_glued_unknown_id_left_alone():
    # unknown glued id: nothing in the map is a prefix -> leave it untouched
    assert slack.resolve_slack_refs("x U9ZZZZZZZZNope y", {}) == "x U9ZZZZZZZZNope y"


# --- thread reader (B2) --------------------------------------------------

def test_map_thread_messages_resolves_and_sorts():
    # conversations.replies (Slack web API) returns message dicts with raw
    # <@U…> mention tokens and an author `user` id.
    raw = [
        {"type": "message", "user": "U0123ABCD",
         "text": "reply to <@U3B6KNK8B>", "ts": "1780670002.000200"},
        {"type": "message", "user": "U0456EFGH",
         "text": "the original question", "ts": "1780670000.000100"},
    ]
    um = {"U3B6KNK8B": "Chris B", "U0123ABCD": "Taylor Corrado", "U0456EFGH": "Jed L"}
    out = slack.map_thread_messages(raw, um)
    assert [m["text"] for m in out] == [
        "the original question", "reply to @Chris B"]          # sorted oldest-first
    assert out[0]["user"] == "Jed L"
    assert out[1]["user"] == "Taylor Corrado"
    assert out[1]["ts"] == "1780670002.000200"


def test_map_thread_messages_skips_non_messages():
    raw = [{"type": "message", "user": "U1", "text": "hi", "ts": "2.0"},
           {"subtype": "channel_join", "type": "message", "user": "U1",
            "text": "joined", "ts": "1.0", "subtype_join": True}]
    out = slack.map_thread_messages(raw, {"U1": "Ann"})
    # join/system noise filtered; only the real message remains
    assert [m["text"] for m in out] == ["hi"]


def test_map_items_resolves_names_in_title():
    mentions = slack.parse_csv_lines(
        '1780670000.111111,U0123ABCD,taylor,Taylor Corrado,#general,,'
        '"hi U3B6KNK8B can you check?",' + ISO + ',0,')
    mentions[0]["time"] = NOW
    items = slack.map_items([], mentions, handle_map={}, now_ms=NOW,
                            user_map={"U3B6KNK8B": "Chris B"})
    assert items[0]["title"] == "hi @Chris B can you check?"
