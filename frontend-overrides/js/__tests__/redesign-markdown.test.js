import { test } from 'node:test';
import assert from 'node:assert';
import { renderMarkdown, inline } from '../redesign/markdown.js';

test('XSS: raw HTML in source is escaped, never injected', () => {
  const html = renderMarkdown('hello <img src=x onerror=alert(1)> <script>bad()</script>');
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test('bold, italic, strikethrough', () => {
  assert.match(inline('a **bold** b'), /a <strong>bold<\/strong> b/);
  assert.match(inline('a *it* b'), /a <em>it<\/em> b/);
  assert.match(inline('a _it_ b'), /a <em>it<\/em> b/);
  assert.match(inline('a ~~no~~ b'), /a <del>no<\/del> b/);
});

test('bold wins over italic for double-asterisks', () => {
  const html = inline('**strong**');
  assert.match(html, /<strong>strong<\/strong>/);
  assert.doesNotMatch(html, /<em>/);
});

test('inline code is escaped and not markdown-processed', () => {
  const html = inline('use `<b>**x**</b>` here');
  assert.match(html, /<code class="code-inline">&lt;b&gt;\*\*x\*\*&lt;\/b&gt;<\/code>/);
  assert.doesNotMatch(html, /<strong>/); // ** inside code stays literal
});

test('snake_case is not italicized', () => {
  assert.doesNotMatch(inline('my_var_name and foo_bar'), /<em>/);
});

test('links: safe schemes pass, javascript: is defused', () => {
  assert.match(inline('[site](https://example.com)'), /<a href="https:\/\/example\.com"[^>]*>site<\/a>/);
  const evil = inline('[x](javascript:alert(1))');
  assert.match(evil, /href="#"/);
  assert.doesNotMatch(evil, /javascript:/);
});

test('workspace vault links open via file action instead of navigating', () => {
  const html = inline('[draft](~/.openclaw/workspace/project-notes.md)');
  assert.match(html, /class="file-link"/);
  assert.match(html, /data-act="wsOpenFile"/);
  assert.match(html, /data-arg="project-notes\.md"/);
  assert.doesNotMatch(html, /href="#"/);
});

test('absolute workspace links are normalized before opening', () => {
  const html = inline('[draft](/home/frank/.openclaw/workspace/memory/radar.md)');
  assert.match(html, /data-act="wsOpenFile"/);
  assert.match(html, /data-arg="memory\/radar\.md"/);
});

test('headings', () => {
  assert.match(renderMarkdown('# Title'), /<h1 class="md-h">Title<\/h1>/);
  assert.match(renderMarkdown('### Sub'), /<h3 class="md-h">Sub<\/h3>/);
});

test('unordered and ordered lists with inline formatting', () => {
  const ul = renderMarkdown('- one\n- **two**\n- three');
  assert.match(ul, /<ul class="md-list"><li>one<\/li><li><strong>two<\/strong><\/li><li>three<\/li><\/ul>/);
  const ol = renderMarkdown('1. first\n2. second');
  assert.match(ol, /<ol class="md-list"><li>first<\/li><li>second<\/li><\/ol>/);
  // A list that doesn't start at 1 must carry `start="N"` so the visible
  // numbering is preserved (e.g. after a code block breaks a list in two).
  const olStart2 = renderMarkdown('2. second\n3. third');
  assert.match(olStart2, /<ol class="md-list" start="2"><li>second<\/li><li>third<\/li><\/ol>/);
});

test('fenced code block keeps content literal and escaped', () => {
  const html = renderMarkdown('```\nconst a = 1 < 2 && 3;\n```');
  // The code content must be HTML-escaped (the security-critical property).
  assert.match(html, /<code>const a = 1 &lt; 2 &amp;&amp; 3;<\/code>/);
  // ...and no raw, unescaped form may leak through.
  assert.doesNotMatch(html, /const a = 1 < 2 && 3;/);
  // The block is wrapped in <pre class="md-code"> with the copy-code affordance.
  assert.match(html, /<pre class="md-code"><button[^>]*class="md-copy-btn"/);
});

test('paragraphs split on blank lines; single newline becomes <br>', () => {
  const html = renderMarkdown('line one\nline two\n\nsecond para');
  assert.match(html, /<p>line one<br>line two<\/p>/);
  assert.match(html, /<p>second para<\/p>/);
});

test('mixed document: heading + para + list renders all blocks', () => {
  const html = renderMarkdown('# What it nails\n\nGreat **summary** here.\n\n- point a\n- point b');
  assert.match(html, /<h1 class="md-h">What it nails<\/h1>/);
  assert.match(html, /<p>Great <strong>summary<\/strong> here\.<\/p>/);
  assert.match(html, /<ul class="md-list">/);
});

test('empty / nullish input is safe', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('GFM table: header + delimiter + rows render as a real table', () => {
  const html = renderMarkdown('| Test | Result |\n|------|--------|\n| api | 401 |\n| nav | 302 |');
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<thead><tr><th[^>]*>Test<\/th><th[^>]*>Result<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody>.*<td[^>]*>api<\/td><td[^>]*>401<\/td>.*<\/tbody>/s);
  assert.doesNotMatch(html, /\|/); // no raw pipes leak through
});

test('GFM table: cells get inline formatting and are XSS-safe', () => {
  const html = renderMarkdown('| Col |\n|-----|\n| **b** |\n| <img src=x> |');
  assert.match(html, /<td[^>]*><strong>b<\/strong><\/td>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('GFM table: colon alignment sets text-align', () => {
  const html = renderMarkdown('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |');
  assert.match(html, /<th style="text-align:left">L<\/th>/);
  assert.match(html, /<th style="text-align:center">C<\/th>/);
  assert.match(html, /<th style="text-align:right">R<\/th>/);
});

test('a lone line with a pipe but no delimiter row stays a paragraph', () => {
  const html = renderMarkdown('a | b | c is just prose');
  assert.match(html, /<p>a \| b \| c is just prose<\/p>/);
  assert.doesNotMatch(html, /<table/);
});

test('table directly under a paragraph (no blank line) still renders', () => {
  const html = renderMarkdown('Results below:\n| K | V |\n|---|---|\n| x | 1 |');
  assert.match(html, /<p>Results below:<\/p>/);
  assert.match(html, /<table class="md-table">/);
});

test('linkifyPaths: a path-looking link label is not double-wrapped in a nested file-link span', () => {
  // The markdown link itself already makes "src/app.py" the click target (an
  // <a> to the URL); wrapping the same text in a second, nested
  // data-act="wsOpenFile" span put two conflicting click targets on one run
  // of text.
  const html = inline('[src/app.py](https://example.com/pr/1)');
  assert.match(html, /<a href="https:\/\/example\.com\/pr\/1"[^>]*>src\/app\.py<\/a>/);
  assert.doesNotMatch(html, /<span class="file-link"/);
});

test('linkifyPaths still linkifies a bare path outside any link', () => {
  const html = inline('see src/app.py for details');
  assert.match(html, /<span class="file-link" data-act="wsOpenFile" data-arg="src\/app\.py">src\/app\.py<\/span>/);
});

test('linkifyPaths: a path-looking segment after a link (outside the <a>) still linkifies', () => {
  const html = inline('[docs](https://example.com) also see src/app.py');
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>docs<\/a>/);
  assert.match(html, /<span class="file-link" data-act="wsOpenFile" data-arg="src\/app\.py">src\/app\.py<\/span>/);
});

// ---------------------------------------------------------------------------
// Rider (task-w6): the code-span/file-link restore runs AFTER linkifyPaths,
// so its own inAnchor guard doesn't cover it — a markdown link whose label is
// a code span containing a path (e.g. [`src/app.py`](url)) still nested a
// data-act="wsOpenFile" <code> element inside the <a>, the exact "two click
// targets on one run of text" problem the linkifyPaths guard above already
// solved for plain-text paths.
// ---------------------------------------------------------------------------
test('a code-span file path used as a link label renders a plain code span inside the anchor, no data-act', () => {
  const html = inline('[`src/app.py`](https://example.com/pr/1)');
  assert.match(html, /<a href="https:\/\/example\.com\/pr\/1"[^>]*><code class="code-inline">src\/app\.py<\/code><\/a>/);
  assert.doesNotMatch(html, /data-act="wsOpenFile"/);
  assert.doesNotMatch(html, /file-link/);
});

test('a code-span file path OUTSIDE any link still gets the clickable file-link code span', () => {
  const html = inline('see `src/app.py` for details');
  assert.match(html, /<code class="code-inline file-link" data-act="wsOpenFile" data-arg="src\/app\.py">src\/app\.py<\/code>/);
});

test('fenced code block with a language captures it as a label + hljs class', () => {
  const html = renderMarkdown('```python\nprint(1)\n```');
  assert.match(html, /<pre class="md-code" data-lang="python">/);
  assert.match(html, /<span class="md-code-lang">python<\/span>/);
  assert.match(html, /<code class="language-python">print\(1\)<\/code>/);
});

test('fenced code block with no language omits the label and hljs class', () => {
  const html = renderMarkdown('```\nplain\n```');
  assert.doesNotMatch(html, /data-lang=/);
  assert.doesNotMatch(html, /md-code-lang/);
  assert.match(html, /<code>plain<\/code>/);
});

test('fenced code block language token is HTML-escaped', () => {
  const html = renderMarkdown('```"><script>\nx\n```');
  assert.doesNotMatch(html, /<script>/);
});

test('block math: multi-line $$...$$ becomes a math-block div with raw LaTeX preserved', () => {
  const html = renderMarkdown('$$\n\\int_0^1 x\\,dx\n$$');
  assert.match(html, /<div class="math-block" data-math="\\int_0\^1 x\\,dx">/);
});

test('block math: multi-line \\[...\\] becomes a math-block div', () => {
  const html = renderMarkdown('\\[\nE = mc^2\n\\]');
  assert.match(html, /<div class="math-block" data-math="E = mc\^2">E = mc\^2<\/div>/);
});

test('block math: single-line $$...$$ on one line still renders as a block', () => {
  const html = renderMarkdown('$$x^2 + y^2 = z^2$$');
  assert.match(html, /<div class="math-block" data-math="x\^2 \+ y\^2 = z\^2">/);
});

test('block math: adjacent to a paragraph with no blank line still splits correctly', () => {
  const html = renderMarkdown('Consider:\n$$x^2$$\nDone.');
  assert.match(html, /<p>Consider:<\/p>/);
  assert.match(html, /<div class="math-block" data-math="x\^2">/);
  assert.match(html, /<p>Done\.<\/p>/);
});

test('block math content is HTML-escaped in both the attribute and fallback text', () => {
  const html = renderMarkdown('$$\na < b & c\n$$');
  assert.match(html, /data-math="a &lt; b &amp; c"/);
  assert.match(html, />a &lt; b &amp; c<\/div>/);
});

test('block math: a closed $$...$$ block still renders as a math-block (regression check)', () => {
  const html = renderMarkdown('$$\nx = 1\n$$');
  assert.match(html, /<div class="math-block" data-math="x = 1">x = 1<\/div>/);
});

test('block math: an unclosed $$ block (still streaming) renders as plain text, not a math-block', () => {
  const html = renderMarkdown('$$\n\\int_0^1');
  assert.doesNotMatch(html, /class="math-block"/);
  assert.match(html, /\\int_0\^1/);
});

test('block math: an unclosed \\[ block (still streaming) renders as plain text, not a math-block', () => {
  const html = renderMarkdown('\\[\nE = mc^2');
  assert.doesNotMatch(html, /class="math-block"/);
  assert.match(html, /E = mc\^2/);
});

test('inline math: \\(...\\) becomes a math-inline span with raw LaTeX preserved', () => {
  const html = inline('mass-energy is \\(E=mc^2\\) in relativity');
  assert.match(html, /mass-energy is <span class="math-inline" data-math="E=mc\^2">E=mc\^2<\/span> in relativity/);
});

test('inline math survives alongside bold/italic without cross-interference', () => {
  const html = inline('**important**: \\(a_b + c\\) matters');
  assert.match(html, /<strong>important<\/strong>/);
  assert.match(html, /<span class="math-inline" data-math="a_b \+ c">a_b \+ c<\/span>/);
  // the underscore inside the math span must NOT have been italicized
  assert.doesNotMatch(html, /<em>b \+ c<\/em>/);
});

test('inline math content is HTML-escaped', () => {
  const html = inline('\\(a < b\\)');
  assert.match(html, /data-math="a &lt; b"/);
  assert.match(html, />a &lt; b<\/span>/);
});

test('inline math is not confused by a literal parenthesis inside the expression', () => {
  const html = inline('\\(f(x) = x^2\\)');
  assert.match(html, /<span class="math-inline" data-math="f\(x\) = x\^2">/);
});

test('a lone backslash-paren with no matching close is left as literal text', () => {
  const html = inline('cost is \\(5 dollars, not math');
  assert.doesNotMatch(html, /math-inline/);
  assert.match(html, /cost is/);
});
