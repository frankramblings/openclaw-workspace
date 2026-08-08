"""AskUserQuestion tool_events must carry `input` so history replay can rebuild
the tappable card (see chat.js fetchThread / buildQuestionCardModel). Every
other tool's event must NOT gain an `input` key — this is scoped narrowly."""
from backend.bridge import _map_history


def test_map_history_askuserquestion_carries_input():
    msgs = [
        {"role": "user", "content": "pick one", "timestamp": 100},
        {"role": "assistant", "timestamp": 101, "content": [
            {"type": "toolCall", "id": "t1", "name": "AskUserQuestion",
             "input": {"questions": [{"question": "Which color?",
                                       "options": ["Red", "Blue"]}]}}]},
    ]
    out = _map_history(msgs)
    turn = out["history"][1]
    te = turn["metadata"]["tool_events"]
    assert len(te) == 1
    ev = te[0]
    assert ev["tool"] == "AskUserQuestion"
    assert ev["input"]["questions"][0]["question"] == "Which color?"


def test_map_history_bash_tool_event_has_no_input_key():
    msgs = [
        {"role": "assistant", "content": [
            {"type": "toolCall", "id": "c1", "name": "bash",
             "arguments": {"command": "ls -la"}}]},
    ]
    ev = _map_history(msgs)["history"][0]["metadata"]["tool_events"][0]
    assert ev["tool"] == "bash"
    assert "input" not in ev
