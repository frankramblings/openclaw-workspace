"""research_render — turn a finished deep-research record into a smart,
interactive, self-contained HTML report.

The research pipeline already captures structure it used to flatten into a wall
of markdown: sources[] (ordered; index+1 == citation number), findings[] (each
{title,url,summary}), and inline [n] citations in the body. This module shapes
that same data into an answer-first report:

  - answer card (the "Bottom Line") with an auto-derived confidence read
  - provenance strip (rounds / sources / duration / model)
  - interactive citations: click [n] -> popover with the source's finding
    summary + live link; the matching source card flashes into view
  - a comparison matrix when the record carries a `comparison` block
    (built at save time for "X vs Y" queries — see research.py::_maybe_compare)
  - numbered source cards

render_html(rec) is pure: rec is the dict from _load_record (query, result,
sources, findings, rounds, duration, model, source_count, comparison?).
"""
from __future__ import annotations

import html
import json
import re

__all__ = ["render_html"]


# ---------- helpers ----------

def _domain(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url or "")
    return (m.group(1).replace("www.", "") if m else "")


def _md_inline(text: str) -> str:
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(
        r"\[(\d+)\]",
        lambda m: '<button class="cite" data-n="%s">%s</button>' % (m.group(1), m.group(1)),
        text,
    )
    return text


def _is_table_sep(s: str) -> bool:
    """A GFM table separator row, e.g. `|---|:--:|---|`."""
    return bool(re.match(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$", s or ""))


def _split_row(s: str) -> list:
    s = s.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _render_table(header: list, rows: list) -> str:
    n = len(header)
    head = "".join("<th>%s</th>" % _md_inline(c) for c in header)
    body = []
    for r in rows:
        cells = (r + [""] * n)[:n]
        body.append("<tr>%s</tr>" % "".join("<td>%s</td>" % _md_inline(c) for c in cells))
    return ('<div class="tbl"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>'
            % (head, "".join(body)))


# Sections already surfaced elsewhere (the answer card) — don't repeat in the body.
_SKIP_BODY_SECTIONS = {"bottom line", "tl;dr", "tldr"}


def _md_to_html(body: str):
    """Minimal markdown -> html, scoped to what these reports emit. Returns
    (title, html). Title is the first H1 (page title, not repeated in body).
    H2 sections become collapsed-by-default accordions so the report reads
    answer-first instead of as one wall of text; GFM pipe tables render as
    real tables."""
    body = re.split(r"\n##\s+Sources\s*\n", body)[0]  # drop the flat source list
    lines = body.split("\n")
    title = None
    sections = []            # [(heading|None, [html_parts])]
    cur_head, cur = None, []
    in_ul = [False]

    def close_ul():
        if in_ul[0]:
            cur.append("</ul>")
            in_ul[0] = False

    def flush_section():
        nonlocal cur_head, cur
        close_ul()
        sections.append((cur_head, cur))
        cur_head, cur = None, []

    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        h = re.match(r"^(#{1,4})\s+(.*)$", line)
        if h:
            close_ul()
            level, txt = len(h.group(1)), h.group(2)
            if level == 1 and title is None:
                title = txt
            elif level == 2:
                flush_section()
                cur_head = txt
            else:
                cur.append("<h%d>%s</h%d>" % (level, _md_inline(txt), level))
            i += 1
            continue
        # GFM table: a pipe row immediately followed by a separator row.
        if "|" in line and i + 1 < n and _is_table_sep(lines[i + 1]):
            close_ul()
            header = _split_row(line)
            j = i + 2
            trows = []
            while j < n and "|" in lines[j] and lines[j].strip():
                trows.append(_split_row(lines[j]))
                j += 1
            cur.append(_render_table(header, trows))
            i = j
            continue
        li = re.match(r"^\s*-\s+(.*)$", line)
        if li:
            if not in_ul[0]:
                cur.append("<ul>")
                in_ul[0] = True
            cur.append("<li>%s</li>" % _md_inline(li.group(1)))
            i += 1
            continue
        if line.strip() == "":
            close_ul()
            i += 1
            continue
        close_ul()
        para = [line]
        j = i + 1
        while (j < n and lines[j].strip() != ""
               and not re.match(r"^\s*-\s+|^#{1,4}\s+", lines[j])
               and not ("|" in lines[j] and j + 1 < n and _is_table_sep(lines[j + 1]))):
            para.append(lines[j])
            j += 1
        cur.append("<p>%s</p>" % _md_inline(" ".join(p.strip() for p in para)))
        i = j
    flush_section()

    out, first_open_used = [], False
    for head, parts in sections:
        inner = "\n".join(parts).strip()
        if head is None:
            if inner:
                out.append(inner)
            continue
        if head.strip().lower() in _SKIP_BODY_SECTIONS:
            continue
        if not inner:
            continue
        open_attr = " open" if not first_open_used else ""
        first_open_used = True
        out.append('<details class="sec"%s><summary>%s</summary>'
                    '<div class="sec-body">%s</div></details>'
                    % (open_attr, _md_inline(head), inner))
    return title, "\n".join(out)


_LEAD_HEADINGS = ("Bottom Line", "TL;DR", "TLDR", "Key Takeaway", "Executive Summary",
                  "Summary", "Verdict", "Recommendation", "Answer")


def _lead_answer(body: str) -> str:
    """The report's headline answer: the first conclusion-style section if one
    exists, else the first substantive paragraph after the H1."""
    for name in _LEAD_HEADINGS:
        m = re.search(r"\n##\s+%s\b[^\n]*\n(.*?)(?=\n##\s|\Z)" % re.escape(name),
                      body, re.S | re.I)
        if m and m.group(1).strip():
            return m.group(1).strip()
    # fallback: first non-heading paragraph
    for para in re.split(r"\n\s*\n", re.sub(r"^#.*$", "", body, flags=re.M)):
        p = para.strip()
        if p and not p.startswith(("-", "|", "#")):
            return p
    return ""


def _confidence(text: str):
    t = text.lower()
    hedges = ["appears", "likely", "cannot be proven", "not yet", "unclear",
              "may ", "suggest", "seems", "less specific", "uncertain"]
    strong = ["confirms", "confirmed", "official", "clearly", "definitively", "proven"]
    h = sum(t.count(w) for w in hedges)
    s = sum(t.count(w) for w in strong)
    if h >= 3 and h > s:
        return ("medium", "Qualified — based on partial/preorder info")
    if s > h:
        return ("high", "Well-supported across sources")
    return ("medium", "Reasoned from available sources")


# ---------- css / js ----------

_CSS = """
:root{--paper:#faf9f7;--ink:#1a1714;--muted:#6b635a;--line:#e6e0d8;--card:#fff;
--accent:#4a3fb5;--accent-soft:#efedff;--hi:#c0392b;--hi-soft:#fdece9;
--green:#1f7a4d;--green-soft:#e8f5ee;--amber:#b5731a;--amber-soft:#fbf0df;
--shadow:0 1px 2px rgba(20,15,10,.04),0 8px 30px rgba(20,15,10,.06)}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
font:16px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:32px 22px 120px}
.kicker{font:600 12px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h1.title{font:600 30px/1.22 Georgia,serif;margin:14px 0 6px;letter-spacing:-.01em}
.query{color:var(--muted);font-size:14.5px;margin:0 0 18px}
.prov{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 26px}
.prov span{font:600 11.5px/1 ui-monospace,monospace;color:var(--muted);background:#fff;
border:1px solid var(--line);border-radius:999px;padding:6px 11px}
.prov b{color:var(--ink)}
.answer{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);
border-radius:14px;padding:20px 22px;box-shadow:var(--shadow);margin:0 0 26px}
.answer .verdict{font:500 19px/1.5 Georgia,serif;margin:10px 0 0}
.conf{display:inline-flex;align-items:center;gap:7px;margin-top:16px;
font:600 12px/1 ui-monospace,monospace;padding:6px 11px;border-radius:999px}
.conf.high{background:var(--green-soft);color:var(--green)}
.conf.medium{background:var(--amber-soft);color:var(--amber)}
.conf .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.matrix{margin:0 0 30px}
.matrix h2{font:600 13px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;
color:var(--muted);margin:0 0 12px}
.grid{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow)}
.grow{display:grid;grid-template-columns:1.1fr 1fr 1fr;border-top:1px solid var(--line)}
.grow:first-child{border-top:0}
.grow>div{padding:12px 14px;font-size:14px;border-left:1px solid var(--line)}
.grow>div:first-child{border-left:0;font-weight:600;background:#fbfaf8}
.grow.head>div{background:var(--ink);color:#fff;font:600 13px/1.3 sans-serif}
.grow.head>div:first-child{color:#cfc9c0}
.grow .win{color:var(--green);font-weight:600}
.grow.conflict>div{background:var(--hi-soft)}
.flag{display:inline-block;font:600 10px/1 ui-monospace,monospace;letter-spacing:.08em;color:var(--hi);
border:1px solid #eab8b0;border-radius:999px;padding:3px 7px;margin-left:6px;vertical-align:middle}
article h2{font:600 20px/1.3 Georgia,serif;margin:34px 0 10px}
article h3{font:600 16px/1.3 sans-serif;margin:22px 0 6px}
article h4{font:600 14px/1.3 sans-serif;margin:16px 0 4px;color:var(--muted)}
article p{margin:10px 0}article ul{margin:10px 0;padding-left:20px}article li{margin:5px 0}
.sec{border:1px solid var(--line);border-radius:12px;margin:0 0 11px;background:var(--card);
box-shadow:var(--shadow);overflow:hidden}
.sec>summary{cursor:pointer;list-style:none;padding:15px 18px;font:600 16.5px/1.3 Georgia,serif;
display:flex;align-items:center;justify-content:space-between;gap:12px;user-select:none}
.sec>summary::-webkit-details-marker{display:none}
.sec>summary::after{content:"+";color:var(--muted);font:400 21px/1 sans-serif;flex:0 0 auto}
.sec[open]>summary::after{content:"\\2013"}
.sec>summary:hover{background:#fbfaf8}
.sec[open]>summary{border-bottom:1px solid var(--line)}
.sec-body{padding:4px 18px 16px}
.sec-body>:first-child{margin-top:10px}
.tbl{overflow-x:auto;margin:14px 0;border:1px solid var(--line);border-radius:10px}
.tbl table{border-collapse:collapse;width:100%;font-size:13.5px}
.tbl th,.tbl td{padding:9px 12px;text-align:left;vertical-align:top;border-top:1px solid var(--line);
border-left:1px solid var(--line)}
.tbl tr:first-child th{border-top:0}.tbl th:first-child,.tbl td:first-child{border-left:0}
.tbl th{background:#f5f2ee;font-weight:600;color:var(--ink)}
.tbl tbody tr:nth-child(even) td{background:#fbfaf8}
.cite{font:600 10px/1 ui-monospace,monospace;color:var(--accent);background:var(--accent-soft);
border:1px solid #d9d5ff;border-radius:6px;padding:1px 5px;margin:0 1px;cursor:pointer;vertical-align:super;transition:.12s}
.cite:hover,.cite.active{background:var(--accent);color:#fff}
.sources{margin-top:44px}
.sources h2{font:600 13px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
.src{display:flex;gap:13px;padding:14px 16px;background:var(--card);border:1px solid var(--line);
border-radius:11px;margin-bottom:9px;transition:.18s;scroll-margin-top:16px}
.src.flash{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.src .n{flex:0 0 auto;width:26px;height:26px;border-radius:7px;background:var(--ink);color:#fff;
font:700 12px/26px ui-monospace,monospace;text-align:center}
.src .t{font-weight:600;font-size:14.5px;margin:0 0 2px}
.src .t a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
.src .t a:hover{border-color:var(--accent);color:var(--accent)}
.src .d{font:600 11px/1 ui-monospace,monospace;color:var(--accent);margin:0 0 6px}
.src .s{font-size:13.5px;color:var(--muted);margin:0}
#pop{position:fixed;z-index:50;max-width:340px;background:var(--ink);color:#f3efe9;border-radius:12px;
padding:14px 15px;box-shadow:0 12px 40px rgba(0,0,0,.28);font-size:13px;line-height:1.5;display:none}
#pop .pn{font:600 11px/1 ui-monospace,monospace;color:#a99bff;margin:0 0 6px;letter-spacing:.06em}
#pop .pt{font-weight:600;margin:0 0 6px;color:#fff}
#pop a{color:#b9afff;font-size:12px;word-break:break-all}
.foot{margin-top:40px;color:var(--muted);font-size:12px;text-align:center}
"""

_JS = """
const DATA=%s;const pop=document.getElementById('pop');
function hide(){pop.style.display='none';document.querySelectorAll('.cite.active').forEach(c=>c.classList.remove('active'));}
document.addEventListener('click',e=>{
 const c=e.target.closest('.cite');
 if(!c){if(!e.target.closest('#pop'))hide();return;}
 e.stopPropagation();
 const n=+c.dataset.n,src=DATA.sources[n-1],find=DATA.findings[n-1];if(!src)return;
 document.querySelectorAll('.cite.active').forEach(x=>x.classList.remove('active'));c.classList.add('active');
 pop.innerHTML='<div class="pn">SOURCE ['+n+']</div><div class="pt">'+(src.title||'')+'</div><div>'+
  ((find&&find.summary)||'')+'</div><div style="margin-top:8px"><a href="'+src.url+'" target="_blank" rel="noopener">'+src.url+'</a></div>';
 pop.style.display='block';
 const r=c.getBoundingClientRect(),pw=Math.min(340,innerWidth-24);
 let left=Math.max(12,Math.min(r.left,innerWidth-pw-12)),top=r.bottom+8;
 if(top+180>innerHeight)top=Math.max(12,r.top-180);
 pop.style.left=left+'px';pop.style.top=top+'px';
 const card=document.getElementById('src-'+n);
 if(card){card.scrollIntoView({behavior:'smooth',block:'center'});card.classList.add('flash');setTimeout(()=>card.classList.remove('flash'),1400);}
});
addEventListener('scroll',hide,{passive:true});addEventListener('resize',hide);
"""


def _render_matrix(mx: dict) -> str:
    # Column headers: prefer the N-column `columns` list; fall back to the
    # legacy two-column `col_a`/`col_b` shape so older reports keep rendering.
    cols = mx.get("columns")
    if not isinstance(cols, list) or not cols:
        cols = [mx.get("col_a", "A"), mx.get("col_b", "B")]
    n = len(cols)
    # One label column (1.1fr) plus one equal column per option.
    tmpl = "1.1fr " + " ".join(["1fr"] * n)

    def _cells(r: dict) -> list:
        c = r.get("cells")
        if isinstance(c, list) and c:
            vals = list(c)
        else:  # legacy a/b
            vals = [r.get("a", ""), r.get("b", "")]
        return (vals + [""] * n)[:n]

    def _winner_idx(r: dict):
        w = r.get("winner")
        if w is None or w == "" or isinstance(w, bool):
            return None
        if isinstance(w, int):
            return w
        s = str(w).strip()
        if s.isdigit():
            return int(s)
        legacy = {"a": 0, "b": 1}.get(s.lower())
        if legacy is not None:
            return legacy
        for i, cn in enumerate(cols):  # allow naming the winning column outright
            if str(cn).strip().lower() == s.lower():
                return i
        return None

    head = '<div class="grow head" style="grid-template-columns:%s"><div>%s</div>%s</div>' % (
        tmpl, html.escape(mx.get("dimension_label", "Feature")),
        "".join("<div>%s</div>" % html.escape(str(c)) for c in cols))
    rows = [head]
    for r in mx.get("rows", []):
        cls = "grow conflict" if r.get("conflict") else "grow"
        flag = '<span class="flag">CONFLICT</span>' if r.get("conflict") else ""
        win = _winner_idx(r)
        cell_html = "".join(
            '<div class="%s">%s</div>' % ("win" if win == i else "", _md_inline(str(v)))
            for i, v in enumerate(_cells(r)))
        rows.append('<div class="%s" style="grid-template-columns:%s"><div>%s%s</div>%s</div>' % (
            cls, tmpl, html.escape(str(r.get("label", ""))), flag, cell_html))
    return ('<section class="matrix"><h2>%s</h2><div class="grid">%s</div></section>'
            % (html.escape(mx.get("title", "At a glance")), "\n".join(rows)))


# ---------- entry point ----------

def render_html(rec: dict) -> str:
    body = rec.get("result") or ""
    sources = rec.get("sources") or []
    findings = rec.get("findings") or []
    title, body_html = _md_to_html(body)
    title = title or (rec.get("query") or "Research Report")[:120]

    bottom = _lead_answer(body)
    conf_cls, conf_txt = _confidence(bottom or body)
    verdict = _md_inline(bottom.split("\n\n")[0]) if bottom else ""

    prov = []
    if rec.get("rounds"):
        prov.append(("rounds", rec["rounds"]))
    prov.append(("sources", str(rec.get("source_count") or len(sources))))
    if rec.get("duration"):
        prov.append(("time", rec["duration"]))
    if rec.get("model"):
        prov.append(("model", rec["model"]))
    prov_html = "".join('<span>%s&nbsp;<b>%s</b></span>' % (html.escape(k), html.escape(str(v)))
                        for k, v in prov)

    mx = rec.get("comparison")
    matrix_html = _render_matrix(mx) if isinstance(mx, dict) and mx.get("rows") else ""

    cards = []
    for i, s in enumerate(sources, 1):
        f = findings[i - 1] if i - 1 < len(findings) else {}
        cards.append(
            '<div class="src" id="src-%d"><div class="n">%d</div><div>'
            '<div class="d">%s</div><div class="t"><a href="%s" target="_blank" rel="noopener">%s</a></div>'
            '<div class="s">%s</div></div></div>' % (
                i, i, html.escape(_domain(s.get("url", ""))),
                html.escape(s.get("url", "")), html.escape(s.get("title", "")),
                html.escape((f or {}).get("summary", ""))))
    cards_html = "\n".join(cards)

    answer = ""
    if verdict:
        answer = ('<section class="answer"><div class="kicker">Bottom Line</div>'
                  '<div class="verdict">%s</div>'
                  '<div class="conf %s"><span class="dot"></span>%s · %s</div></section>'
                  % (verdict, conf_cls, conf_cls.upper() + " CONFIDENCE", html.escape(conf_txt)))

    data_json = json.dumps({"sources": sources, "findings": findings}).replace("</", "<\\/")

    return """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s</title><style>%s</style></head><body><div class="wrap">
<div class="kicker">Deep Research</div>
<h1 class="title">%s</h1>
<p class="query">%s</p>
<div class="prov">%s</div>
%s%s
<article>%s</article>
<section class="sources"><h2>Sources · %d</h2>%s</section>
<div class="foot">Rendered from the report's own structured data — click any [n] to inspect its source.</div>
</div><div id="pop"></div><script>%s</script></body></html>""" % (
        html.escape(title), _CSS, html.escape(title),
        html.escape(rec.get("query") or ""), prov_html,
        answer, matrix_html, body_html,
        len(sources), cards_html, _JS % data_json)
