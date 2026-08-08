from backend import bridge

def test_askuserquestion_is_in_strip_input_allowlist():
    assert "AskUserQuestion" in bridge._STRIP_INPUT_TOOLS

def test_other_tools_not_added():
    # guard: allowlist stays tight (regression tripwire)
    assert "Bash" not in bridge._STRIP_INPUT_TOOLS
    assert "Read" not in bridge._STRIP_INPUT_TOOLS
