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
  assert.match(html, /<pre class="md-code"><code>const a = 1 &lt; 2 &amp;&amp; 3;<\/code><\/pre>/);
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
