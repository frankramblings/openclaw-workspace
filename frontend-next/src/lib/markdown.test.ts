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

test('fenced code block keeps content literal and escaped, emits code-card markup with lang', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2 && 3;\n```')
  expect(html).toMatch(/<code class="language-js">const a = 1 &lt; 2 &amp;&amp; 3;<\/code>/)
  expect(html).not.toMatch(/const a = 1 < 2 && 3;/)
  expect(html).toMatch(/<div class="code-card md-fence" data-lang="js" data-lines="1">/)
  expect(html).toMatch(/<button class="copy" data-act="codeCopy">Copy<\/button>/)
  expect(html).toMatch(/<span class="lang">js<\/span>/)
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

test('fenced code block without lang uses empty data-lang', () => {
  const html = renderMarkdown('```\nplain text\n```')
  expect(html).toMatch(/<div class="code-card md-fence" data-lang="" data-lines="1">/)
  expect(html).toMatch(/<span class="lang">text<\/span>/)
})

test('fenced code block >30 lines gets collapsed class and expand button', () => {
  const lines = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`).join('\n')
  const html = renderMarkdown('```\n' + lines + '\n```')
  // Single merged class attribute, not a second duplicate `class="collapsed"`
  // after the first (invalid HTML — a real parser drops the duplicate, so a
  // string/regex check alone can't catch a broken attribute; assert on the
  // actual attribute value AND on parsed classList so this can't regress
  // silently again).
  expect(html).toMatch(/class="code-card md-fence collapsed"/)
  expect((html.match(/class="/g) ?? []).length).toBeGreaterThan(0)
  const el = document.createElement('div')
  el.innerHTML = html
  const card = el.querySelector('.code-card')!
  expect(card.classList.contains('collapsed')).toBe(true)
  expect(card.classList.contains('md-fence')).toBe(true)
  expect(html).toMatch(/<button class="code-expand" data-act="codeExpand">Show all 35 lines<\/button>/)
  expect(html).toMatch(/data-lines="35"/)
})

test('fenced code block <=30 lines does NOT get collapsed class or expand button', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
  const html = renderMarkdown('```\n' + lines + '\n```')
  expect(html).not.toMatch(/class="collapsed"/)
  expect(html).not.toMatch(/code-expand/)
  expect(html).toMatch(/data-lines="20"/)
})

test('unclosed fenced code block at end of input gets data-open="1"', () => {
  const html = renderMarkdown('```js\nconst x = 1')
  expect(html).toMatch(/data-open="1"/)
  expect(html).not.toMatch(/class="collapsed"/) // never collapsed when streaming
})

test('mermaid fence generates mermaid-card instead of code-card', () => {
  const html = renderMarkdown('```mermaid\ngraph TD\\n  A --> B\n```')
  expect(html).toMatch(/<div class="mermaid-card" data-mermaid=/)
  expect(html).not.toMatch(/code-card/)
  expect(html).toMatch(/<pre>graph TD/)
})

test('inline math with \\(...\\) delimiters generates math-inline span', () => {
  const html = inline('The formula \\(E=mc^2\\) is famous')
  expect(html).toMatch(/<span class="math-inline" data-math="E=mc\^2">E=mc\^2<\/span>/)
})

test('block math with $$ delimiters generates a math-block div per CONTRACT.md (not math-inline)', () => {
  const html = inline('Formula: $$a^2 + b^2 = c^2$$')
  expect(html).toMatch(/<div class="math-block" data-math="a\^2 \+ b\^2 = c\^2">a\^2 \+ b\^2 = c\^2<\/div>/)
  expect(html).not.toMatch(/math-inline/)
})

test('block math with \\[...\\] delimiters generates a math-block div', () => {
  const html = inline('See \\[x = \\frac{-b}{2a}\\]')
  expect(html).toMatch(/<div class="math-block" data-math=/)
  expect(html).not.toMatch(/math-inline/)
})

test('single $ is NOT treated as math delimiter', () => {
  const html = inline('The price is $100 per item')
  expect(html).not.toMatch(/data-math/)
  expect(html).toMatch(/\$100 per item/)
})

test('math inside code spans is ignored', () => {
  const html = inline('code: `$$not math$$`')
  expect(html).toMatch(/<code class="code-inline">\$\$not math\$\$<\/code>/)
  expect(html).not.toMatch(/data-math/)
})

test('attribute escaping in data-lang for special characters', () => {
  const html = renderMarkdown('```c++\nx\n```')
  expect(html).toMatch(/data-lang="c\+\+"/)
  expect(html).toMatch(/<span class="lang">c\+\+<\/span>/)
})

test('attribute escaping in data-math for quotes and angle brackets', () => {
  const html = inline('Math with \\(x < y & "z"\\)')
  expect(html).toMatch(/data-math="x &lt; y &amp; &quot;z&quot;"/)
})

// --- Adversarial probes (thrifty-check UNIT-101 security pass) --------------

test('adversarial: hostile fence info string cannot inject an attribute/tag via data-lang', () => {
  const html = renderMarkdown('```javascript"><img src=x onerror=alert(1)>\nbody\n```')
  expect(html).not.toMatch(/<img/)
  expect(html).not.toMatch(/onerror=/)
  // extractLangFromFence only captures the leading [a-z0-9+#-]+ run, so the
  // hostile suffix is dropped, not escaped-and-kept.
  expect(html).toMatch(/data-lang="javascript"/)
  expect(html).toMatch(/<span class="lang">javascript<\/span>/)
})

test('adversarial: hostile latex in block math ($$) is contained in data-math and the visible fallback', () => {
  const html = inline('$$"><script>alert(1)</script>$$')
  expect(html).not.toMatch(/<script>/)
  expect(html).toMatch(/<div class="math-block" data-math="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;">/)
  // visible fallback content uses the same escaped text, not raw
  expect(html).toMatch(/>&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/div>/)
})

test('adversarial: a stray ) inside \\(...\\) breaks math extraction but still falls through escaped, never raw', () => {
  // The \(...\) extraction regex is paren-naive ([^)]+), so a raw ')' inside
  // the payload (from "alert(1)") stops it from ever finding a matching "\)"
  // closer — the whole span falls through unextracted. That's a parsing-
  // completeness quirk, not an escaping bug: the escape-first pass still runs
  // on whatever wasn't extracted, so the tag is neutralized either way.
  const html = inline('\\("><img src=x onerror=alert(1)>\\)')
  expect(html).not.toMatch(/data-math/)
  expect(html).not.toMatch(/<img/)
  expect(html).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('adversarial: hostile latex in inline math (\\(...\\)) without embedded parens is contained in data-math and the visible fallback', () => {
  const html = inline('\\("><img src=x onerror=alert1>\\)')
  expect(html).not.toMatch(/<img/)
  expect(html).toMatch(/data-math="&quot;&gt;&lt;img src=x onerror=alert1&gt;"/)
})

test('adversarial: hostile mermaid source is contained in data-mermaid and the visible <pre> fallback', () => {
  const html = renderMarkdown('```mermaid\n"><script>alert(1)</script>\n```')
  expect(html).not.toMatch(/<script>/)
  expect(html).toMatch(/data-mermaid="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/)
  expect(html).toMatch(/<pre>&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/pre>/)
})

test('adversarial: raw NUL/SOH sentinel-shaped bytes in source text cannot collide with a real code-span sentinel', () => {
  // Before the fix, a literal "\x00<digits>\x01" run in ordinary text (no
  // backticks at all, so codes[] is empty) reached codes[+i].trim() with
  // raw === undefined and threw. It must now render as inert, escaped text
  // and never throw.
  const hostile = 'hello \x000\x01 world'
  expect(() => inline(hostile)).not.toThrow()
  const html = inline(hostile)
  expect(html).not.toMatch(/<code/)
  expect(html).toMatch(/hello/)
  expect(html).toMatch(/world/)
})

test('adversarial: raw NUL/SOH bytes cannot spoof a reference to an unrelated real code span in the same message', () => {
  // A real code span exists (codes[0] = "secret"); attacker-controlled text
  // elsewhere in the same message must not be able to forge a sentinel that
  // re-displays it a second time via a fake control-byte pair.
  const hostile = 'code `secret` then fake \x000\x01 ref'
  const html = inline(hostile)
  const occurrences = html.match(/secret/g) ?? []
  expect(occurrences.length).toBe(1)
})

test('adversarial: raw STX/ETX (math sentinel) bytes in source text do not crash or leak raw math markup', () => {
  const hostile = 'price \x020\x03 tag'
  expect(() => inline(hostile)).not.toThrow()
  const html = inline(hostile)
  expect(html).not.toMatch(/data-math/)
})

test('precedence: math is never recognized inside a fenced code block (fence wins over math-in-fence)', () => {
  const html = renderMarkdown('```\n$$a^2+b^2=c^2$$\n\\(x\\)\n```')
  expect(html).not.toMatch(/data-math/)
  expect(html).not.toMatch(/math-block|math-inline/)
  expect(html).toMatch(/\$\$a\^2\+b\^2=c\^2\$\$/) // literal, escaped-safe text inside <code>
})

test('precedence: an unescaped fence delimiter inside a $$ block breaks the block scan (fence-line wins over math)', () => {
  // A literal ``` line always starts a new fenced block at the outer parser
  // level (line-level scan happens before paragraph/inline math extraction),
  // so a "$$" that never finds its closing "$$" on the same inline() call
  // renders as inert literal text either side of the resulting code-card —
  // never as unescaped/broken markup.
  const html = renderMarkdown('$$\n```\nx\n```\n$$')
  expect(html).toMatch(/<div class="code-card md-fence"/)
  expect(html).not.toMatch(/data-math/)
})

test('nested: math delimiters inside a mermaid fence are not recognized as math', () => {
  const html = renderMarkdown('```mermaid\ngraph TD\n  A -->|$$x$$| B\n```')
  expect(html).toMatch(/<div class="mermaid-card"/)
  expect(html).not.toMatch(/data-math/)
  expect(html).toMatch(/A --&gt;\|\$\$x\$\$\| B/)
})
