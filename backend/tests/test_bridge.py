"""Unit tests for bridge pure functions (history mapping)."""
from backend.bridge import _map_history


def test_map_history_carries_per_message_timestamp():
    # The brain stores an epoch-ms `timestamp` on every message; the SPA renders
    # it via msg.metadata.timestamp and falls back to now() when it's missing
    # (the "every message shows the reload time" bug). The mapper must pass it.
    msgs = [
        {"role": "user", "content": "hi", "timestamp": 1780591399764},
        {"role": "assistant", "content": [{"type": "text", "text": "yo"}],
         "model": "gpt-5.5", "timestamp": 1780591402292},
    ]
    out = _map_history(msgs)
    assert out["history"][0]["role"] == "user"
    assert out["history"][0]["metadata"]["timestamp"] == 1780591399764
    assert out["history"][1]["metadata"]["timestamp"] == 1780591402292
    assert out["model"] == "gpt-5.5"


def test_map_history_tolerates_missing_timestamp():
    out = _map_history([{"role": "user", "content": "hi"}])
    # still maps; metadata.timestamp is None (frontend then falls back to now)
    assert out["history"][0]["metadata"]["timestamp"] is None


def test_map_history_propagates_per_message_usage_metadata():
    # Data-rich chat parity: the gateway stamps each assistant turn with usage/
    # model/provider; the mapper must surface them on metadata for the drawer.
    msgs = [{
        "role": "assistant",
        "content": [{"type": "text", "text": "done"}],
        "model": "claude-opus-4-8",
        "provider": "claude-cli",
        "stopReason": "end_turn",
        "usage": {"input": 2, "output": 75, "cacheRead": 69469, "cacheWrite": 282},
    }]
    meta = _map_history(msgs)["history"][0]["metadata"]
    assert meta["usage"] == {"input": 2, "output": 75,
                             "cacheRead": 69469, "cacheWrite": 282}
    assert meta["model"] == "claude-opus-4-8"
    assert meta["provider"] == "claude-cli"
    assert meta["stopReason"] == "end_turn"
    assert "cost" not in meta  # plan-billed: no cost record


def test_map_history_usage_metadata_is_optional():
    # A turn with no usage/cost (e.g. plan-billed or partial) still maps cleanly,
    # carrying only what's present — no empty/None keys for absent fields.
    msgs = [{"role": "assistant", "content": [{"type": "text", "text": "hi"}]}]
    meta = _map_history(msgs)["history"][0]["metadata"]
    assert "usage" not in meta and "cost" not in meta and "provider" not in meta


# --- Tool-use reconstruction (the "Gary's tool uses vanish on reload" bug) ---
# The brain stores an agentic turn as a flat run of messages: assistant turns
# whose content is EITHER text blocks OR toolCall blocks (never both), plus
# `toolResult` messages keyed by toolCallId. The old mapper dropped every
# toolCall/toolResult, so a reload showed only the user's side of any turn that
# used tools. The mapper must now rebuild the renderer's tool_events/round_texts
# metadata (see chatRenderer.addMessage) so reload matches the live view.

def test_map_history_reconstructs_tool_card():
    msgs = [
        {"role": "user", "content": "list files", "timestamp": 100},
        {"role": "assistant", "timestamp": 101, "model": "gpt-5.5",
         "provider": "openai",
         "content": [{"type": "toolCall", "id": "c1", "name": "bash",
                      "arguments": {"command": "ls -la", "cwd": "/tmp"}}]},
        {"role": "toolResult", "toolCallId": "c1", "toolName": "bash",
         "isError": False,
         "content": [{"type": "toolResult", "content": "file1\nfile2"}]},
        {"role": "assistant", "timestamp": 102,
         "content": [{"type": "text", "text": "Found 2 files."}]},
    ]
    out = _map_history(msgs)
    h = out["history"]
    assert h[0]["role"] == "user"
    turn = h[1]
    assert turn["role"] == "assistant"
    te = turn["metadata"]["tool_events"]
    assert len(te) == 1
    ev = te[0]
    assert ev["tool"] == "bash"
    assert ev["command"] == "ls -la"          # bash command lifted verbatim
    assert ev["output"] == "file1\nfile2"     # result body restored
    assert ev["exit_code"] == 0               # isError False -> success
    assert ev["round"] == 1
    rt = turn["metadata"]["round_texts"]
    # final text lands in a round AFTER the tools so it renders below the card
    assert rt[ev["round"]].strip() == "Found 2 files."
    # turn timestamp is the turn start (first message), not the trailing text
    assert turn["metadata"]["timestamp"] == 101


def test_map_history_marks_tool_error_exit_code():
    msgs = [
        {"role": "assistant",
         "content": [{"type": "toolCall", "id": "c9", "name": "bash",
                      "arguments": {"command": "false"}}]},
        {"role": "toolResult", "toolCallId": "c9", "isError": True,
         "content": [{"type": "toolResult", "content": "boom"}]},
    ]
    ev = _map_history(msgs)["history"][0]["metadata"]["tool_events"][0]
    assert ev["exit_code"] == 1               # isError True -> failed card
    assert ev["output"] == "boom"


def test_map_history_groups_multi_round_turn():
    # text -> tool -> text -> tool -> text becomes 3 rounds in one bubble.
    msgs = [
        {"role": "assistant", "content": [{"type": "text", "text": "Let me check."}]},
        {"role": "assistant",
         "content": [{"type": "toolCall", "id": "a", "name": "bash",
                      "arguments": {"command": "step1"}}]},
        {"role": "toolResult", "toolCallId": "a",
         "content": [{"type": "toolResult", "content": "ok1"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Now step 2."}]},
        {"role": "assistant",
         "content": [{"type": "toolCall", "id": "b", "name": "bash",
                      "arguments": {"command": "step2"}}]},
        {"role": "toolResult", "toolCallId": "b",
         "content": [{"type": "toolResult", "content": "ok2"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "All done."}]},
    ]
    meta = _map_history(msgs)["history"][0]["metadata"]
    assert [t.strip() for t in meta["round_texts"]] == \
        ["Let me check.", "Now step 2.", "All done."]
    rounds = {e["command"]: e["round"] for e in meta["tool_events"]}
    assert rounds == {"step1": 1, "step2": 2}


def test_map_history_non_string_tool_input_serialized():
    # Non-bash tools carry structured input; show it rather than dropping it.
    msgs = [
        {"role": "assistant",
         "content": [{"type": "toolCall", "id": "z", "name": "web_search",
                      "arguments": {"query": "python 3.14", "count": 5}}]},
        {"role": "toolResult", "toolCallId": "z",
         "content": [{"type": "toolResult", "content": "results"}]},
    ]
    ev = _map_history(msgs)["history"][0]["metadata"]["tool_events"][0]
    assert ev["tool"] == "web_search"
    assert "python 3.14" in ev["command"]      # structured input rendered


# --- claude-cli (Claude Code agent) transcript shape ---
# Unlike OpenAI, claude-cli stores blocks with LOWERCASE types (`toolcall`,
# `tool_result`, `thinking`, `text`) and puts the tool_result INLINE in the
# assistant message content (same list as its toolcall), keyed by `tool_use_id`
# with an `is_error` flag — NOT as a separate role:"toolResult" message. The
# mapper must reconstruct the same tool_events/round_texts from this shape.

def test_map_history_reconstructs_claude_cli_inline_tool_card():
    msgs = [
        {"role": "user", "content": "run echo", "timestamp": 200},
        {"role": "assistant", "timestamp": 201, "model": "claude-opus-4-8",
         "provider": "anthropic", "content": [
             {"type": "toolcall", "id": "toolu_1", "name": "Bash",
              "arguments": {"command": "echo hi"}},
             {"type": "tool_result", "tool_use_id": "toolu_1", "name": "Bash",
              "is_error": False, "content": "hi\n"}]},
        {"role": "assistant", "timestamp": 202,
         "content": [{"type": "text", "text": "Done — printed hi."}]},
    ]
    out = _map_history(msgs)
    h = out["history"]
    assert h[0]["role"] == "user"
    turn = h[1]
    te = turn["metadata"]["tool_events"]
    assert len(te) == 1
    ev = te[0]
    assert ev["tool"] == "Bash"
    assert ev["command"] == "echo hi"         # arguments.command lifted verbatim
    assert ev["output"] == "hi\n"             # inline tool_result body restored
    assert ev["exit_code"] == 0               # is_error False -> success
    assert ev["round"] == 1
    rt = turn["metadata"]["round_texts"]
    assert rt[ev["round"]].strip() == "Done — printed hi."
    assert turn["metadata"]["timestamp"] == 201
    assert out["model"] == "claude-opus-4-8"


def test_map_history_claude_cli_marks_is_error():
    msgs = [
        {"role": "assistant", "content": [
            {"type": "toolcall", "id": "toolu_9", "name": "Bash",
             "arguments": {"command": "false"}},
            {"type": "tool_result", "tool_use_id": "toolu_9", "name": "Bash",
             "is_error": True, "content": "boom"}]},
    ]
    ev = _map_history(msgs)["history"][0]["metadata"]["tool_events"][0]
    assert ev["exit_code"] == 1               # is_error True -> failed card
    assert ev["output"] == "boom"


def test_map_history_claude_cli_tool_result_block_list_content():
    # claude-cli tool_result content can be a block list, e.g. ToolSearch's
    # tool_reference or a text block — flatten it the same as a string body.
    msgs = [
        {"role": "assistant", "content": [
            {"type": "toolcall", "id": "toolu_a", "name": "mcp__openclaw__message",
             "arguments": {"action": "send", "message": "hello"}},
            {"type": "tool_result", "tool_use_id": "toolu_a",
             "name": "mcp__openclaw__message", "content": [
                 {"type": "text", "text": "Sent visible reply."}]}]},
    ]
    ev = _map_history(msgs)["history"][0]["metadata"]["tool_events"][0]
    assert ev["tool"] == "mcp__openclaw__message"
    assert ev["output"] == "Sent visible reply."


def test_map_history_claude_cli_groups_multi_round_turn():
    # text -> [toolcall+tool_result] -> text -> [toolcall+tool_result] -> text,
    # with inline results, still collapses into 3 rounds in one bubble.
    msgs = [
        {"role": "assistant", "content": [{"type": "text", "text": "Let me check."}]},
        {"role": "assistant", "content": [
            {"type": "toolcall", "id": "a", "name": "Bash",
             "arguments": {"command": "step1"}},
            {"type": "tool_result", "tool_use_id": "a", "content": "ok1"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Now step 2."}]},
        {"role": "assistant", "content": [
            {"type": "toolcall", "id": "b", "name": "Bash",
             "arguments": {"command": "step2"}},
            {"type": "tool_result", "tool_use_id": "b", "content": "ok2"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "All done."}]},
    ]
    meta = _map_history(msgs)["history"][0]["metadata"]
    assert [t.strip() for t in meta["round_texts"]] == \
        ["Let me check.", "Now step 2.", "All done."]
    rounds = {e["command"]: e["round"] for e in meta["tool_events"]}
    assert rounds == {"step1": 1, "step2": 2}
    outputs = {e["command"]: e["output"] for e in meta["tool_events"]}
    assert outputs == {"step1": "ok1", "step2": "ok2"}


def test_map_history_claude_cli_message_tool_is_canonical_reply():
    # claude-cli delivers Gary's real reply via mcp__openclaw__message; the live
    # view shows that (the trailing text block is reply_reset away). Reload must
    # show the SAME reply — not the terse trailing note — so a refresh doesn't
    # swap the answer for a differently-worded one.
    msgs = [
        {"role": "user", "content": "disk?", "timestamp": 1},
        {"role": "assistant", "model": "claude-opus-4-8", "content": [
            {"type": "toolcall", "id": "t1", "name": "Bash",
             "arguments": {"command": "df -h /"}},
            {"type": "tool_result", "tool_use_id": "t1", "content": "ok", "name": "Bash"}]},
        {"role": "assistant", "content": [
            {"type": "toolcall", "id": "t2", "name": "mcp__openclaw__message",
             "arguments": {"action": "send", "message": "**Disk**: 61 GB free."}},
            {"type": "tool_result", "tool_use_id": "t2", "name": "mcp__openclaw__message",
             "content": [{"type": "text", "text": "Sent."}]}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Done — 61 GB free."}]},
    ]
    turn = _map_history(msgs)["history"][1]
    rts = [t for t in turn["metadata"]["round_texts"] if t.strip()]
    # the LAST round text (what the redesign renders as the reply bubble) and the
    # backend content are the message-tool reply, not the terse trailing note.
    assert rts[-1] == "**Disk**: 61 GB free."
    assert turn["content"] == "**Disk**: 61 GB free."
    # the trailing note is preserved as an earlier round (not lost), just not last.
    assert any("Done — 61 GB free." in t for t in turn["metadata"]["round_texts"])


def test_map_history_gpt_message_tool_not_treated_as_reply():
    # gpt's reply-delivery tool is plain `message` — the claude-cli override is
    # scoped to mcp__openclaw__message, so this path is UNCHANGED: the trailing
    # text block stays the reply.
    msgs = [
        {"role": "assistant", "content": [{"type": "toolCall", "id": "c1",
            "name": "message", "arguments": {"message": "delivered version"}}]},
        {"role": "toolResult", "toolCallId": "c1",
         "content": [{"type": "toolResult", "content": "Sent."}]},
        {"role": "assistant", "content": [{"type": "text", "text": "final text reply"}]},
    ]
    turn = _map_history(msgs)["history"][0]
    rts = [t for t in turn["metadata"]["round_texts"] if t.strip()]
    assert rts[-1] == "final text reply"  # unchanged: the text note is the reply


def test_map_history_claude_cli_message_reply_falls_back_to_text():
    # No message tool (pure text answer after a tool) → keep the text block.
    msgs = [
        {"role": "assistant", "content": [
            {"type": "toolcall", "id": "t1", "name": "Bash",
             "arguments": {"command": "ls"}},
            {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Here are the files."}]},
    ]
    turn = _map_history(msgs)["history"][0]
    assert turn["content"] == "Here are the files."


def test_map_history_plaintext_turns_unchanged():
    # Regression: a turn with NO tools still emits one entry per assistant
    # message (legacy behavior the chat drawer/metrics rely on).
    msgs = [
        {"role": "user", "content": "hi", "timestamp": 1},
        {"role": "assistant", "content": [{"type": "text", "text": "hello"}],
         "model": "gpt-5.5", "timestamp": 2},
        {"role": "assistant", "content": [{"type": "text", "text": "more"}],
         "timestamp": 3},
    ]
    h = _map_history(msgs)["history"]
    assert [m["role"] for m in h] == ["user", "assistant", "assistant"]
    assert h[1]["content"] == "hello" and "tool_events" not in h[1]["metadata"]
    assert h[2]["content"] == "more"
    assert h[1]["metadata"]["timestamp"] == 2


def test_default_model_floats_to_front_of_its_provider(monkeypatch):
    """The SPA picker auto-defaults new chats to models[0] — that slot must be
    the configured primary, not whatever sorts first in the gateway catalog
    (gpt-5.4's arrival sorted ahead of gpt-5.5 and silently became the
    default for every new chat)."""
    from backend import bridge, config
    monkeypatch.setattr(config, "default_model", lambda: ("openai", "gpt-5.5"))
    payload = {"models": [
        {"id": "gpt-5.4", "provider": "openai", "name": "GPT-5.4"},
        {"id": "gpt-5.4-mini", "provider": "openai", "name": "GPT-5.4 mini"},
        {"id": "gpt-5.5", "provider": "openai", "name": "GPT-5.5"},
        {"id": "sonnet", "provider": "anthropic", "name": "Sonnet"},
    ]}
    out = bridge._build_model_items(payload, {})
    openai_item = next(i for i in out["items"] if i["endpoint_id"] == "openai")
    assert openai_item["models"][0] == "gpt-5.5"
    # Parallel display list must stay aligned with the reordered ids.
    assert openai_item["models_display"][0] == "GPT-5.5"
    # Non-default entries keep their relative order after the default.
    assert openai_item["models"][1:] == ["gpt-5.4", "gpt-5.4-mini"]
