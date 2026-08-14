from backend import systemd_units as su


# Real output shape, captured from this box on 2026-08-13.
SHOW_TWO = """\
Id=hp-trans-probe.service
ActiveState=inactive
Result=success
ExecMainPID=0
ExecMainStatus=0

Id=openclaw-gateway.service
ActiveState=active
Result=success
ExecMainPID=2830447
ExecMainStatus=0
"""


def test_parse_show_splits_on_blank_lines():
    blocks = su.parse_show(SHOW_TWO)
    assert [b["Id"] for b in blocks] == ["hp-trans-probe.service",
                                         "openclaw-gateway.service"]


def test_parse_show_keeps_values_verbatim():
    blocks = su.parse_show(SHOW_TWO)
    assert blocks[1]["ExecMainPID"] == "2830447"
    assert blocks[0]["Result"] == "success"


def test_parse_show_tolerates_a_value_containing_equals():
    # Description carries the whole command line, which routinely has '='.
    text = "Id=x.service\nDescription=[systemd-run] /bin/foo --flag=1 --other=2\n"
    (block,) = su.parse_show(text)
    assert block["Description"] == "[systemd-run] /bin/foo --flag=1 --other=2"


def test_parse_show_ignores_lines_without_a_key():
    text = "Id=x.service\ngarbage line\nActiveState=active\n"
    (block,) = su.parse_show(text)
    assert block == {"Id": "x.service", "ActiveState": "active"}


def test_parse_show_of_nothing_is_empty():
    assert su.parse_show("") == []
    assert su.parse_show("\n\n") == []


def test_list_active_returns_service_names():
    out = ("hp-a.service   loaded active running   Some job\n"
           "hp-b.service   loaded active running   Another job\n")
    assert su.list_active(run=lambda _argv: out) == ["hp-a.service", "hp-b.service"]


def test_list_active_ignores_blank_and_short_lines():
    assert su.list_active(run=lambda _argv: "\n   \nhp-a.service loaded active running x\n") \
        == ["hp-a.service"]


def test_list_active_survives_systemd_being_unavailable():
    # systemd unavailable => follower off, per the spec's degradation rule.
    # It must read as "no units", never raise.
    def boom(_argv):
        raise OSError("no systemd")
    assert su.list_active(run=boom) == []


def test_show_maps_units_by_id():
    got = su.show(["a.service", "b.service"], run=lambda _argv: SHOW_TWO)
    assert set(got) == {"hp-trans-probe.service", "openclaw-gateway.service"}
    assert got["openclaw-gateway.service"]["ActiveState"] == "active"


def test_show_of_no_units_makes_no_call():
    calls = []

    def spy(argv):
        calls.append(argv)
        return ""
    assert su.show([], run=spy) == {}
    assert calls == []


def test_show_asks_for_every_property_the_follower_needs():
    calls = []

    def spy(argv):
        calls.append(argv)
        return ""
    su.show(["a.service"], run=spy)
    argv = calls[0]
    for prop in su.SHOW_PROPS:
        assert "-p" in argv and prop in argv
    assert "--user" in argv


def test_show_survives_systemd_being_unavailable():
    def boom(_argv):
        raise OSError("no systemd")
    assert su.show(["a.service"], run=boom) == {}
