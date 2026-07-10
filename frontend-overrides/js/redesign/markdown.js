// Minimal, self-contained Markdown → HTML for chat messages.
//
// Safety model: escape-first. Every piece of source text is HTML-escaped before
// any markdown transform runs, so message content can never inject HTML. Markdown
// tokens (`**`, `*`, `` ` ``, `[](…)`, `#`, `-`…) are ASCII and survive escaping.
// Links are restricted to http(s)/mailto/relative; anything else is defused.
//
// Scope is the common chat subset — headings, bold/italic/strike, inline code,
// fenced code, links, ordered/unordered lists, blockquotes, hr, GFM pipe tables,
// paragraphs with soft line breaks. Nested lists are intentionally out of scope.
import { esc } from './dom.js';

// Sentinels that protect inline-code spans from markdown/escaping. NUL never
// appears in chat text and esc() leaves it untouched, so it round-trips safely.
const C0 = '\u0000';
const C1 = '\u0001';

function safeUrl(url) {
  return /^(https?:|mailto:|\/|#)/i.test(String(url || '').trim()) ? url : '#';
}

function isVaultPath(url) {
  const s = String(url || '').trim();
  if (/^(https?:|mailto:|#)/i.test(s)) return false;
  return /^~\/\.openclaw\/workspace\//.test(s)
    || s.includes('/.openclaw/workspace/')
    || isFilePath(s);
}

function workspacePath(url) {
  const s = String(url || '').trim();
  const tilde = '~/.openclaw/workspace/';
  const marker = '/.openclaw/workspace/';
  if (s.startsWith(tilde)) return { path: s.slice(tilde.length), root: 'workspace' };
  const i = s.indexOf(marker);
  if (i >= 0) return { path: s.slice(i + marker.length), root: 'workspace' };
  // ~/… paths outside the vault (e.g. ~/.openclaw/skill-workshop/…, ~/meetings/…,
  // ~/.claude/…) go through the `home` root allowlist in workspace_files.py.
  if (s.startsWith('~/')) return { path: s.slice(2), root: 'home' };
  return { path: s, root: 'workspace' };
}

function link(text, url) {
  if (isVaultPath(url)) {
    const { path, root } = workspacePath(url);
    const rootAttr = root === 'workspace' ? '' : ` data-root="${esc(root)}"`;
    return `<span class="file-link" data-act="wsOpenFile" data-arg="${esc(path)}"${rootAttr}>${text}</span>`;
  }
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

// Inline image sharing (parity with desktop markdown.js _extractSharedImages).
// The agent shares an existing file with `MEDIA:<path>` on its own line; it may
// also paste a raw `<img src="data:image/…">` or `![alt](data:image/…)`. These
// aren't markdown, so we lift them out before line parsing and emit real <img>s
// (local paths served by the allow-listed /api/workspace-media route).
function sharedImageHtml(src) {
  const e = esc(src);
  // data-act="imgView" → tapping opens the fullscreen viewer (see app.js).
  return `<div class="shared-image" data-act="imgView" data-arg="${e}">`
    + `<img src="${e}" alt="shared image" loading="lazy"></div>`;
}

function extractSharedImages(text) {
  let imagesHtml = '';
  text = text.replace(/<img\b[^>]*?\bsrc\s*=\s*["'](data:image\/[^"']+)["'][^>]*>/gi,
    (_m, src) => { imagesHtml += sharedImageHtml(src); return ''; });
  text = text.replace(/!\[[^\]]*\]\((data:image\/[^)\s]+)\)/gi,
    (_m, src) => { imagesHtml += sharedImageHtml(src); return ''; });
  text = text.replace(/^[ \t>*-]*MEDIA:\s*`?\s*([^\n`]+?)\s*`?[ \t]*$/gim, (_m, raw) => {
    const p = raw.trim();
    if (!p) return '';
    // http(s), data:, and same-origin URLs (`/api/…`, `/__openclaw__/…`) pass
    // through as-is. Everything else (bare filesystem paths like `/home/frank/…`
    // or `~/…`) goes through the allow-listed workspace-media proxy. Without
    // the `/api/` / `/__openclaw__/` carve-out, managed-outgoing image URLs
    // rehydrated by `_map_history` on refresh got wrapped as file paths and
    // 404'd.
    const isDirectUrl = /^(https?:|data:image\/|\/(api|__openclaw__)\/)/i.test(p);
    const src = isDirectUrl ? p : '/api/workspace-media?path=' + encodeURIComponent(p);
    imagesHtml += sharedImageHtml(src);
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), imagesHtml };
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

// --- GFM pipe tables --------------------------------------------------------
// A table is a header row containing a pipe, immediately followed by a
// delimiter row of dashes (with optional : alignment markers), e.g.
//   | A | B |
//   |:--|--:|
//   | 1 | 2 |
// The delimiter row is what disambiguates a real table from prose that merely
// contains a "|", so a header alone never triggers table parsing.
const RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableSep(line) {
  return line != null && line.includes('-') && RE_TABLE_SEP.test(line);
}

function isTableStart(lines, i) {
  const head = lines[i];
  return head != null && head.includes('|') && /\S/.test(head)
    && isTableSep(lines[i + 1]);
}

// Split one table row into trimmed cells, honoring \| escapes and ignoring the
// optional leading/trailing pipes.
function splitTableRow(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (s[k] === '|') { cells.push(cur); cur = ''; continue; }
    cur += s[k];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function tableAlign(sepRow) {
  return splitTableRow(sepRow).map((c) => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  });
}

export function renderMarkdown(src, topLevel = true) {
  let source = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  // Lift shared images out at the top level only (don't re-scan blockquote
  // recursion, where MEDIA lines would be content, not directives).
  let imagesHtml = '';
  if (topLevel) {
    const ex = extractSharedImages(source);
    source = ex.text;
    imagesHtml = ex.imagesHtml;
  }
  const lines = source.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (RE.fence.test(line)) {            // fenced code block
      i++;
      const buf = [];
      while (i < lines.length && !RE.fence.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume closing fence (if present)
      out.push(`<pre class="md-code"><button type="button" class="md-copy-btn" data-act="copyCode" title="Copy" aria-label="Copy code"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="9" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10"/></svg></button><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (RE.blank.test(line)) { i++; continue; }
    const h = line.match(RE.heading);
    if (h) { const n = h[1].length; out.push(`<h${n} class="md-h">${inline(h[2].trim())}</h${n}>`); i++; continue; }
    if (RE.hr.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }
    if (isTableStart(lines, i)) {         // GFM pipe table
      const header = splitTableRow(lines[i]);
      const align = tableAlign(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && !RE.blank.test(lines[i])
             && lines[i].includes('|') && !startsBlock(lines[i])) {
        rows.push(splitTableRow(lines[i])); i++;
      }
      const alignAttr = (idx) => (align[idx] ? ` style="text-align:${align[idx]}"` : '');
      const thead = `<thead><tr>${header
        .map((c, idx) => `<th${alignAttr(idx)}>${inline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${header
        .map((_, idx) => `<td${alignAttr(idx)}>${inline(r[idx] == null ? '' : r[idx])}</td>`)
        .join('')}</tr>`).join('')}</tbody>`;
      out.push(`<table class="md-table">${thead}${tbody}</table>`);
      continue;
    }
    if (RE.quote.test(line)) {            // blockquote (recursive)
      const buf = [];
      while (i < lines.length && RE.quote.test(lines[i])) { buf.push(lines[i].replace(RE.quote, '')); i++; }
      out.push(`<blockquote class="md-quote">${renderMarkdown(buf.join('\n'), false)}</blockquote>`);
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
    while (i < lines.length && !RE.blank.test(lines[i]) && !startsBlock(lines[i])
           && !isTableStart(lines, i)) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('') + imagesHtml;
}
