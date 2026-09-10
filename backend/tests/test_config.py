

# --- agents.entries (gateway 2026.9.3+) -------------------------------------
# The update replaced `agents.list` (an ARRAY of {id, ...}) with
# `agents.entries` (an OBJECT keyed by agent id). Reading only the old shape
# means agent_id() silently falls through to its "main" guess -- right on this
# box by luck, wrong on any install whose first agent is named anything else,
# and enough to make doctor report agent_id as guessed (which fails the deploy
# gate).
def test_agent_id_reads_entries_object(monkeypatch, tmp_path):
    from backend import config
    monkeypatch.delenv("OPENCLAW_AGENT_ID", raising=False)
    monkeypatch.setattr(config, "load_connection", lambda: {})
    monkeypatch.setattr(config, "_openclaw_json", lambda: {
        "agents": {"entries": {"gary": {"name": "Gary"}, "qwen": {}}}})
    assert config.agent_id() == "gary"


def test_agent_id_still_reads_the_legacy_list(monkeypatch):
    from backend import config
    monkeypatch.delenv("OPENCLAW_AGENT_ID", raising=False)
    monkeypatch.setattr(config, "load_connection", lambda: {})
    monkeypatch.setattr(config, "_openclaw_json", lambda: {
        "agents": {"list": [{"id": "legacy"}]}})
    assert config.agent_id() == "legacy"


def test_agent_id_falls_back_to_main_when_neither_shape_is_present(monkeypatch):
    from backend import config
    monkeypatch.delenv("OPENCLAW_AGENT_ID", raising=False)
    monkeypatch.setattr(config, "load_connection", lambda: {})
    monkeypatch.setattr(config, "_openclaw_json", lambda: {"agents": {}})
    assert config.agent_id() == "main"
