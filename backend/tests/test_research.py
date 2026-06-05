"""Unit tests for the Deep Research engine's pure parts."""
from backend.research import (classify_tool, extract_findings, extract_sources,
                              _model_ref, strip_findings_block)


# --- classify_tool: tool cards → live phase ----------------------------------

def test_search_tools_classify_as_search():
    assert classify_tool("web_search") == "search"
    assert classify_tool("brave-search") == "search"
    assert classify_tool("exec", "duckduckgo 'foo bar'") == "search"


def test_web_fetches_classify_as_read():
    assert classify_tool("web_fetch") == "read"
    assert classify_tool("exec", "curl https://example.com") == "read"
    assert classify_tool("browser", "open page") == "read"


def test_agent_housekeeping_classifies_as_other():
    # The agent reads its own bootstrap/memory files mid-turn — not sources.
    assert classify_tool("exec", "print lines 1-220 from memory/2026-06-05.md") == "other"
    assert classify_tool("exec", "print lines 1-220 from SOUL.md") == "other"
    assert classify_tool(None, None) == "other"


# --- extract_findings: tolerant JSON-block parsing ----------------------------

FINDINGS = '[{"title": "A", "url": "https://a.example", "summary": "s"}]'


def test_extracts_fenced_json_block():
    text = f"I learned things.\n```json\n{FINDINGS}\n```"
    out = extract_findings(text)
    assert out == [{"title": "A", "url": "https://a.example", "summary": "s"}]


def test_prefers_last_block_when_rounds_accumulate():
    # Rounds output cumulative findings each time — the LAST block wins.
    text = ('```json\n[{"title": "old", "url": "https://old.example"}]\n```\n'
            f"more research...\n```json\n{FINDINGS}\n```")
    assert extract_findings(text)[0]["title"] == "A"


def test_falls_back_to_bare_array_and_tolerates_garbage():
    assert extract_findings(f"Findings: {FINDINGS} done") != []
    assert extract_findings("no json here") == []
    assert extract_findings("```json\nnot json\n```") == []
    assert extract_findings("") == []


def test_drops_non_dict_and_empty_entries():
    text = '```json\n["junk", {"summary": "no title or url"}, {"url": "https://b.example"}]\n```'
    out = extract_findings(text)
    assert out == [{"title": "https://b.example", "url": "https://b.example", "summary": ""}]


def test_strip_findings_block_removes_the_fence():
    text = f"summary text\n```json\n{FINDINGS}\n```"
    assert strip_findings_block(text) == "summary text"


# --- extract_sources: dedupe findings + report links --------------------------

def test_sources_merge_findings_then_report_links():
    findings = [{"title": "A", "url": "https://a.example", "summary": ""}]
    report = ("see [A again](https://a.example) and [B](https://b.example)\n"
              "bare https://c.example/page. trailing-dot stripped")
    out = extract_sources(findings, report)
    urls = [s["url"] for s in out]
    assert urls == ["https://a.example", "https://b.example", "https://c.example/page"]
    assert out[0]["title"] == "A"          # findings title wins over link text
    assert out[2]["title"] == "https://c.example/page"  # bare URL → URL as title


# --- _model_ref: research settings → gateway model ref ------------------------

def test_model_ref_combinations():
    assert _model_ref({}) is None
    assert _model_ref({"model": "openclaw"}) is None
    assert _model_ref({"model": "gpt-5.5"}) == "gpt-5.5"
    assert _model_ref({"endpoint_id": "openai", "model": "gpt-5.5"}) == "openai/gpt-5.5"
    assert _model_ref({"endpoint_id": "openclaw", "model": "gpt-5.5"}) == "gpt-5.5"
