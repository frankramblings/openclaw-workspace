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
});

test('fenced code block keeps content literal and escaped', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2 && 3;\n```');
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
