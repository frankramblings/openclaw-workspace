// Converted from frontend-overrides/js/__tests__/redesign-markdown.test.js
// (node:test → vitest). Same cases, same expected strings.
import { test, expect } from 'vitest'
import { renderMarkdown, inline } from './markdown'

test('XSS: raw HTML in source is escaped, never injected', () => {
  const html = renderMarkdown('hello <img src=x onerror=alert(1)> <script>bad()</script>')
  expect(html).not.toMatch(/<img|<script/)
  expect(html).toMatch(/&lt;img/)
  expect(html).toMatch(/&lt;script&gt;/)
})

test('bold, italic, strikethrough', () => {
  expect(inline('a **bold** b')).toMatch(/a <strong>bold<\/strong> b/)
  expect(inline('a *it* b')).toMatch(/a <em>it<\/em> b/)
  expect(inline('a _it_ b')).toMatch(/a <em>it<\/em> b/)
  expect(inline('a ~~no~~ b')).toMatch(/a <del>no<\/del> b/)
})

test('bold wins over italic for double-asterisks', () => {
  const html = inline('**strong**')
  expect(html).toMatch(/<strong>strong<\/strong>/)
  expect(html).not.toMatch(/<em>/)
})

test('inline code is escaped and not markdown-processed', () => {
  const html = inline('use `<b>**x**</b>` here')
  expect(html).toMatch(/<code class="code-inline">&lt;b&gt;\*\*x\*\*&lt;\/b&gt;<\/code>/)
  expect(html).not.toMatch(/<strong>/) // ** inside code stays literal
})

test('snake_case is not italicized', () => {
  expect(inline('my_var_name and foo_bar')).not.toMatch(/<em>/)
})

test('links: safe schemes pass, javascript: is defused', () => {
  expect(inline('[site](https://example.com)')).toMatch(/<a href="https:\/\/example\.com"[^>]*>site<\/a>/)
  const evil = inline('[x](javascript:alert(1))')
  expect(evil).toMatch(/href="#"/)
  expect(evil).not.toMatch(/javascript:/)
})

test('workspace vault links open via file action instead of navigating', () => {
  const html = inline('[draft](~/.openclaw/workspace/project-notes.md)')
  expect(html).toMatch(/class="file-link"/)
  expect(html).toMatch(/data-act="wsOpenFile"/)
  expect(html).toMatch(/data-arg="project-notes\.md"/)
  expect(html).not.toMatch(/href="#"/)
})

test('absolute workspace links are normalized before opening', () => {
  const html = inline('[draft](/home/frank/.openclaw/workspace/memory/radar.md)')
  expect(html).toMatch(/data-act="wsOpenFile"/)
  expect(html).toMatch(/data-arg="memory\/radar\.md"/)
})

test('headings', () => {
  expect(renderMarkdown('# Title')).toMatch(/<h1 class="md-h">Title<\/h1>/)
  expect(renderMarkdown('### Sub')).toMatch(/<h3 class="md-h">Sub<\/h3>/)
})

test('unordered and ordered lists with inline formatting', () => {
  const ul = renderMarkdown('- one\n- **two**\n- three')
  expect(ul).toMatch(/<ul class="md-list"><li>one<\/li><li><strong>two<\/strong><\/li><li>three<\/li><\/ul>/)
  const ol = renderMarkdown('1. first\n2. second')
  expect(ol).toMatch(/<ol class="md-list"><li>first<\/li><li>second<\/li><\/ol>/)
  // A list that doesn't start at 1 must carry `start="N"` so the visible
  // numbering is preserved (e.g. after a code block breaks a list in two).
  const olStart2 = renderMarkdown('2. second\n3. third')
  expect(olStart2).toMatch(/<ol class="md-list" start="2"><li>second<\/li><li>third<\/li><\/ol>/)
})

test('fenced code block keeps content literal and escaped', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2 && 3;\n```')
  expect(html).toMatch(/<code>const a = 1 &lt; 2 &amp;&amp; 3;<\/code>/)
  expect(html).not.toMatch(/const a = 1 < 2 && 3;/)
  expect(html).toMatch(/<pre class="md-code"><button[^>]*class="md-copy-btn"/)
})

test('paragraphs split on blank lines; single newline becomes <br>', () => {
  const html = renderMarkdown('line one\nline two\n\nsecond para')
  expect(html).toMatch(/<p>line one<br>line two<\/p>/)
  expect(html).toMatch(/<p>second para<\/p>/)
})

test('mixed document: heading + para + list renders all blocks', () => {
  const html = renderMarkdown('# What it nails\n\nGreat **summary** here.\n\n- point a\n- point b')
  expect(html).toMatch(/<h1 class="md-h">What it nails<\/h1>/)
  expect(html).toMatch(/<p>Great <strong>summary<\/strong> here\.<\/p>/)
  expect(html).toMatch(/<ul class="md-list">/)
})

test('empty / nullish input is safe', () => {
  expect(renderMarkdown('')).toBe('')
  expect(renderMarkdown(null)).toBe('')
})

test('GFM table: header + delimiter + rows render as a real table', () => {
  const html = renderMarkdown('| Test | Result |\n|------|--------|\n| api | 401 |\n| nav | 302 |')
  expect(html).toMatch(/<table class="md-table">/)
  expect(html).toMatch(/<thead><tr><th[^>]*>Test<\/th><th[^>]*>Result<\/th><\/tr><\/thead>/)
  expect(html).toMatch(/<tbody>.*<td[^>]*>api<\/td><td[^>]*>401<\/td>.*<\/tbody>/s)
  expect(html).not.toMatch(/\|/) // no raw pipes leak through
})

test('GFM table: cells get inline formatting and are XSS-safe', () => {
  const html = renderMarkdown('| Col |\n|-----|\n| **b** |\n| <img src=x> |')
  expect(html).toMatch(/<td[^>]*><strong>b<\/strong><\/td>/)
  expect(html).not.toMatch(/<img/)
  expect(html).toMatch(/&lt;img/)
})

test('GFM table: colon alignment sets text-align', () => {
  const html = renderMarkdown('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |')
  expect(html).toMatch(/<th style="text-align:left">L<\/th>/)
  expect(html).toMatch(/<th style="text-align:center">C<\/th>/)
  expect(html).toMatch(/<th style="text-align:right">R<\/th>/)
})

test('a lone line with a pipe but no delimiter row stays a paragraph', () => {
  const html = renderMarkdown('a | b | c is just prose')
  expect(html).toMatch(/<p>a \| b \| c is just prose<\/p>/)
  expect(html).not.toMatch(/<table/)
})

test('table directly under a paragraph (no blank line) still renders', () => {
  const html = renderMarkdown('Results below:\n| K | V |\n|---|---|\n| x | 1 |')
  expect(html).toMatch(/<p>Results below:<\/p>/)
  expect(html).toMatch(/<table class="md-table">/)
})

test('linkifyPaths: a path-looking link label is not double-wrapped in a nested file-link span', () => {
  const html = inline('[src/app.py](https://example.com/pr/1)')
  expect(html).toMatch(/<a href="https:\/\/example\.com\/pr\/1"[^>]*>src\/app\.py<\/a>/)
  expect(html).not.toMatch(/<span class="file-link"/)
})

test('linkifyPaths still linkifies a bare path outside any link', () => {
  const html = inline('see src/app.py for details')
  expect(html).toMatch(/<span class="file-link" data-act="wsOpenFile" data-arg="src\/app\.py">src\/app\.py<\/span>/)
})

test('linkifyPaths: a path-looking segment after a link (outside the <a>) still linkifies', () => {
  const html = inline('[docs](https://example.com) also see src/app.py')
  expect(html).toMatch(/<a href="https:\/\/example\.com"[^>]*>docs<\/a>/)
  expect(html).toMatch(/<span class="file-link" data-act="wsOpenFile" data-arg="src\/app\.py">src\/app\.py<\/span>/)
})

test('a code-span file path used as a link label renders a plain code span inside the anchor, no data-act', () => {
  const html = inline('[`src/app.py`](https://example.com/pr/1)')
  expect(html).toMatch(/<a href="https:\/\/example\.com\/pr\/1"[^>]*><code class="code-inline">src\/app\.py<\/code><\/a>/)
  expect(html).not.toMatch(/data-act="wsOpenFile"/)
  expect(html).not.toMatch(/file-link/)
})

test('a code-span file path OUTSIDE any link still gets the clickable file-link code span', () => {
  const html = inline('see `src/app.py` for details')
  expect(html).toMatch(/<code class="code-inline file-link" data-act="wsOpenFile" data-arg="src\/app\.py">src\/app\.py<\/code>/)
})
