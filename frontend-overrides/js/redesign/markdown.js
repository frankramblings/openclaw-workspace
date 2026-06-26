// Minimal, self-contained Markdown → HTML for chat messages.
//
// Safety model: escape-first. Every piece of source text is HTML-escaped before
// any markdown transform runs, so message content can never inject HTML. Markdown
// tokens (`**`, `*`, `` ` ``, `[](…)`, `#`, `-`…) are ASCII and survive escaping.
// Links are restricted to http(s)/mailto/relative; anything else is defused.
//
// Scope is the common chat subset — headings, bold/italic/strike, inline code,
// fenced code, links, ordered/unordered lists, blockquotes, hr, paragraphs with
// soft line breaks. Tables and nested lists are intentionally out of scope.
import { esc } from './dom.js';

// Sentinels that protect inline-code spans from markdown/escaping. NUL never
// appears in chat text and esc() leaves it untouched, so it round-trips safely.
const C0 = '\u0000';
const C1 = '\u0001';

function safeUrl(url) {
  return /^(https?:|mailto:|\/|#)/i.test(String(url || '').trim()) ? url : '#';
}

function link(text, url) {
  return `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

// Known text-file extensions whose bare filenames are worth linking (used for
// code spans; plain-text matching requires a slash to reduce false positives).
const FILE_EXTS = /^(md|txt|json|js|mjs|ts|tsx|jsx|py|css|html|htm|sh|yaml|yml|toml|ini|csv|log|sql|env|skill|rb|go|rs|c|cpp|h|java|kt|swift|vue|svelte|php)$/i;

function isFilePath(s) {
  if (!s || /[\s'"<>]/.test(s)) return false;
  if (s.includes('/')) return /\w/.test(s);
  const dot = s.lastIndexOf('.');
  return dot > 0 && FILE_EXTS.test(s.slice(dot + 1));
}

// Turn path-like tokens in HTML text nodes into clickable spans. Splits on HTML
// tags so we never mangle attribute values or tag names. Only matches paths
// with a slash — bare filenames in plain text have too many false positives.
function linkifyPaths(html) {
  const PATH_RE = /(?<![.\w/\\])((?:\.{1,2}\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[\w]{1,10})(?![.\w/])/g;
  return html.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, text) => {
    if (tag) return tag;
    return text.replace(PATH_RE, (path) =>
      `<span class="file-link" data-act="wsOpenFile" data-arg="${esc(path)}">${path}</span>`
    );
  });
}

// Inline formatting on a single run of raw text. Code spans are pulled out and
// escaped separately so their contents are never treated as markdown.
export function inline(text) {
  const codes = [];
  let s = String(text == null ? '' : text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return C0 + (codes.length - 1) + C1;
  });
  s = esc(s); // escape &<>"' on everything that isn't a protected code span
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => link(t, u));
  s = linkifyPaths(s);
  return s.replace(new RegExp(C0 + '(\\d+)' + C1, 'g'), (_, i) => {
    const raw = codes[+i];
    const escaped = esc(raw);
    if (isFilePath(raw.trim())) {
      return `<code class="code-inline file-link" data-act="wsOpenFile" data-arg="${escaped}">${escaped}</code>`;
    }
    return `<code class="code-inline">${escaped}</code>`;
  });
}

const RE = {
  fence: /^```/,
  heading: /^(#{1,6})\s+(.*)$/,
  hr: /^\s*([-*_])\1\1+\s*$/,
  quote: /^\s*>\s?/,
  ul: /^\s*[-*+]\s+/,
  ol: /^\s*\d+[.)]\s+/,
  blank: /^\s*$/,
};

function startsBlock(line) {
  return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line)
    || RE.quote.test(line) || RE.ul.test(line) || RE.ol.test(line);
}

export function renderMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (RE.fence.test(line)) {            // fenced code block
      i++;
      const buf = [];
      while (i < lines.length && !RE.fence.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume closing fence (if present)
      out.push(`<pre class="md-code"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (RE.blank.test(line)) { i++; continue; }
    const h = line.match(RE.heading);
    if (h) { const n = h[1].length; out.push(`<h${n} class="md-h">${inline(h[2].trim())}</h${n}>`); i++; continue; }
    if (RE.hr.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }
    if (RE.quote.test(line)) {            // blockquote (recursive)
      const buf = [];
      while (i < lines.length && RE.quote.test(lines[i])) { buf.push(lines[i].replace(RE.quote, '')); i++; }
      out.push(`<blockquote class="md-quote">${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (RE.ul.test(line)) {               // unordered list
      const items = [];
      while (i < lines.length && RE.ul.test(lines[i])) { items.push(lines[i].replace(RE.ul, '')); i++; }
      out.push(`<ul class="md-list">${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }
    if (RE.ol.test(line)) {               // ordered list
      const items = [];
      while (i < lines.length && RE.ol.test(lines[i])) { items.push(lines[i].replace(RE.ol, '')); i++; }
      out.push(`<ol class="md-list">${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }
    // paragraph: gather consecutive non-blank lines that don't start a block
    const buf = [];
    while (i < lines.length && !RE.blank.test(lines[i]) && !startsBlock(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}
