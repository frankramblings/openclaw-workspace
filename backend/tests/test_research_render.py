"""Behavioral tests for research_render.py: turns a deep-research record dict
into a self-contained HTML report. The module is pure (no I/O, no external
seams) so every test here just feeds a small research-state dict through
render_html()/its helpers and asserts *structural* invariants of the output
(section presence, citation links, escaping, matrix shape) rather than
byte-exact golden HTML, which would rot on every harmless markup tweak.
"""
from __future__ import annotations

from backend import research_render
from backend.research_render import render_html

REC = {
    "query": "Python vs Go for a CLI tool?",
    "result": (
        "# Python vs Go\n"
        "\n"
        "## Bottom Line\n"
        "Go wins for a static-binary CLI [1]. Python is faster to prototype [2].\n"
        "\n"
        "## Details\n"
        "Go compiles to a single binary with no runtime dependency [1].\n"
        "\n"
        "- fast startup\n"
        "- easy cross-compile\n"
        "\n"
        "## Sources\n"
        "[1] https://go.dev\n"
        "[2] https://python.org\n"
    ),
    "sources": [
        {"title": "The Go Programming Language", "url": "https://go.dev"},
        {"title": "Python.org", "url": "https://python.org"},
    ],
    "findings": [
        {"title": "The Go Programming Language", "url": "https://go.dev",
         "summary": "Go's official site: static binaries, fast compiles."},
        {"title": "Python.org", "url": "https://python.org",
         "summary": "Python's official site: rapid prototyping."},
    ],
    "rounds": 3,
    "duration": "42s",
    "model": "opus",
    "source_count": 2,
}


# --- render_html: overall document shape -------------------------------------

def test_render_html_basic_structural_shape():
    out = render_html(REC)
    assert out.startswith("<!doctype html>")
    assert "<title>Python vs Go</title>" in out          # H1 extracted as page title
    assert "Python vs Go for a CLI tool?" in out          # query shown under the title
    assert "Sources · 2" in out
    assert out.count('class="src"') == 2
    assert 'id="src-1"' in out and 'id="src-2"' in out


def test_render_html_provenance_strip_includes_all_present_fields():
    out = render_html(REC)
    assert "<span>rounds&nbsp;<b>3</b></span>" in out
    assert "<span>sources&nbsp;<b>2</b></span>" in out
    assert "<span>time&nbsp;<b>42s</b></span>" in out
    assert "<span>model&nbsp;<b>opus</b></span>" in out


def test_render_html_omits_absent_provenance_fields():
    rec = {k: v for k, v in REC.items() if k not in ("rounds", "duration", "model")}
    out = render_html(rec)
    assert "rounds&nbsp;" not in out
    assert "time&nbsp;" not in out
    assert "model&nbsp;" not in out
    assert "sources&nbsp;<b>2</b>" in out  # source count is always shown


def test_render_html_inline_citations_become_anchors():
    out = render_html(REC)
    assert '<a class="cite" href="#src-1" data-n="1">1</a>' in out
    assert '<a class="cite" href="#src-2" data-n="2">2</a>' in out


def test_render_html_title_falls_back_to_query_when_body_has_no_h1():
    rec = dict(REC, result="No heading at all, just prose.\n")
    out = render_html(rec)
    assert "<title>Python vs Go for a CLI tool?</title>" in out
    assert '<h1 class="title">Python vs Go for a CLI tool?</h1>' in out


def test_render_html_handles_sparse_record_without_crashing():
    """_load_record's real shape varies (comparison/rounds/duration/model are
    all optional) — a minimal dict must still render a valid, non-crashing
    document."""
    minimal = {"result": "# Just a title\n\nSome body text.\n"}
    out = render_html(minimal)
    assert out.startswith("<!doctype html>")
    assert "Sources · 0" in out
    assert 'class="src"' not in out


# --- answer card / confidence -------------------------------------------------

def test_render_html_answer_card_present_with_expected_confidence():
    out = render_html(REC)
    assert '<section class="answer">' in out
    assert 'class="conf medium"' in out  # no hedge/strong signal words in this fixture
    assert "Go wins for a static-binary CLI" in out


def test_render_html_no_answer_card_when_body_is_empty():
    out = render_html(dict(REC, result=""))
    assert 'class="answer"' not in out


def test_render_html_falls_back_to_first_paragraph_when_no_lead_heading():
    rec = dict(REC, result=(
        "# T\n\nJust a plain first paragraph with no headed sections.\n\n"
        "## Details\nmore.\n"))
    out = render_html(rec)
    assert '<div class="verdict">' in out
    verdict = out.split('<div class="verdict">', 1)[1].split("</div>", 1)[0]
    assert verdict.strip() != ""


def test_confidence_classifies_hedged_text_as_medium():
    text = ("It appears likely that this cannot be proven and remains "
            "unclear; it may suggest something less specific, uncertain.")
    cls, _ = research_render._confidence(text)
    assert cls == "medium"


def test_confidence_classifies_assertive_text_as_high():
    text = "Sources confirm this is the official, clearly definitively proven answer."
    cls, _ = research_render._confidence(text)
    assert cls == "high"


def test_confidence_defaults_to_medium_with_no_signal_words():
    cls, _ = research_render._confidence("A plain factual statement with no hedges.")
    assert cls == "medium"


# --- body sections: Bottom Line suppressed, accordions, print expansion -----

def test_render_html_bottom_line_not_repeated_as_a_body_accordion():
    out = render_html(REC)
    assert "Bottom Line</summary>" not in out
    assert "<summary>Details</summary>" in out


def test_render_html_only_first_body_section_open_when_collapsible():
    rec = dict(REC, result=(
        "# T\n## Bottom Line\nAnswer here.\n\n"
        "## Section A\nContent A.\n\n## Section B\nContent B.\n"))
    out = render_html(rec, for_print=False)
    assert '<details class="sec" open><summary>Section A</summary>' in out
    assert '<details class="sec"><summary>Section B</summary>' in out  # no "open"


def test_render_html_for_print_expands_every_section():
    rec = dict(REC, result=(
        "# T\n## Bottom Line\nAnswer here.\n\n"
        "## Section A\nContent A.\n\n## Section B\nContent B.\n"))
    out = render_html(rec, for_print=True)
    assert out.count('<details class="sec" open>') == 2


def test_md_to_html_drops_flat_sources_section():
    body = "# T\n\n## Findings\nSome text.\n\n## Sources\n[1] https://a.example\n"
    _title, body_html = research_render._md_to_html(body)
    assert "https://a.example" not in body_html
    assert "<summary>Findings</summary>" in body_html


def test_md_to_html_renders_gfm_table():
    body = "# T\n## Comparison\n| A | B |\n|---|---|\n| 1 | 2 |\n"
    _title, body_html = research_render._md_to_html(body)
    assert '<div class="tbl"><table>' in body_html
    assert "<th>A</th><th>B</th>" in body_html
    assert "<td>1</td><td>2</td>" in body_html


# --- comparison matrix ---------------------------------------------------------

COMPARISON = {
    "title": "Head to head",
    "dimension_label": "Feature",
    "columns": ["Go", "Python"],
    "rows": [
        {"label": "Startup time", "cells": ["10ms", "80ms"], "winner": 0},
        {"label": "Ecosystem", "cells": ["Smaller", "Huge"], "winner": "Python",
         "conflict": True},
    ],
}


def test_render_html_comparison_matrix_present_when_rows_given():
    out = render_html(dict(REC, comparison=COMPARISON))
    assert '<section class="matrix">' in out
    assert "<h2>Head to head</h2>" in out
    assert '<span class="flag">CONFLICT</span>' in out
    assert 'class="win"' in out


def test_render_html_no_matrix_section_when_comparison_absent():
    assert '<section class="matrix">' not in render_html(REC)


def test_render_html_no_matrix_section_when_comparison_has_no_rows():
    out = render_html(dict(REC, comparison={"title": "x", "rows": []}))
    assert '<section class="matrix">' not in out


def test_render_matrix_marks_the_declared_winner_column():
    mx = {"title": "T", "columns": ["Go", "Python"],
          "rows": [{"label": "X", "cells": ["a", "b"], "winner": 1}]}
    out = research_render._render_matrix(mx)
    assert '<div class="win">b</div>' in out
    assert '<div class="">a</div>' in out


def test_render_matrix_winner_can_name_the_column():
    mx = {"title": "T", "columns": ["Go", "Python"],
          "rows": [{"label": "X", "cells": ["a", "b"], "winner": "Python"}]}
    out = research_render._render_matrix(mx)
    assert '<div class="win">b</div>' in out


def test_render_matrix_no_winner_marks_no_cell():
    mx = {"title": "T", "columns": ["Go", "Python"],
          "rows": [{"label": "X", "cells": ["a", "b"]}]}
    out = research_render._render_matrix(mx)
    assert 'class="win"' not in out


def test_render_matrix_supports_legacy_col_a_col_b_shape():
    mx = {"title": "Legacy", "col_a": "Old", "col_b": "New",
          "rows": [{"label": "Speed", "a": "slow", "b": "fast", "winner": "b"}]}
    out = research_render._render_matrix(mx)
    assert "<div>Old</div>" in out and "<div>New</div>" in out
    assert '<div class="win">fast</div>' in out


# --- escaping / XSS-safety ------------------------------------------------------

def test_render_html_escapes_html_in_query():
    rec = dict(REC, query='<script>alert(1)</script> & "quotes"')
    out = render_html(rec)
    assert "<script>alert(1)</script>" not in out
    assert "&lt;script&gt;" in out


def test_render_html_data_json_neutralizes_closing_script_tag():
    """The embedded `<script>DATA=...</script>` blob must not let a source
    title smuggle in a real closing </script> tag that would break out of
    the JS context; json.dumps(...).replace("</", "<\\/") is the mitigation
    — assert the only literal </script> left in the document is the report's
    own trailing closing tag."""
    rec = dict(REC, sources=[{"title": "</script><script>evil()</script>",
                              "url": "https://x.example"}],
               findings=[{"summary": "ok"}])
    out = render_html(rec)
    assert out.count("</script>") == 1
    assert "<\\/script>" in out


# --- pdf button -----------------------------------------------------------------

def test_render_html_pdf_button_only_when_pdf_url_given():
    assert 'class="pdf-btn"' not in render_html(REC)
    out = render_html(REC, pdf_url="/api/document/x/export-pdf")
    assert 'href="/api/document/x/export-pdf"' in out


# --- small pure helpers -----------------------------------------------------

def test_domain_strips_scheme_and_www():
    assert research_render._domain("https://www.example.com/path") == "example.com"
    assert research_render._domain("http://example.org") == "example.org"
    assert research_render._domain("") == ""
    assert research_render._domain("not a url") == ""


def test_md_inline_bold_italic_and_citation_link():
    out = research_render._md_inline("**bold** and *italic* with cite [3]")
    assert "<strong>bold</strong>" in out
    assert "<em>italic</em>" in out
    assert '<a class="cite" href="#src-3" data-n="3">3</a>' in out


def test_md_inline_escapes_raw_html():
    out = research_render._md_inline("<img src=x onerror=alert(1)>")
    assert "<img" not in out
    assert "&lt;img" in out
