// NOTES surface → real notes vault backend.
// Wires GET /api/notes into state.live.notes.docs in the NOTES mock shape.
// Render (surfaces.js) reads state.live.notes.docs and the active doc is
// docs[state.selDoc]; selDoc is already wired. We only produce the doc list.
// Fails soft: load() throws on error, which keeps the mock.

import { apiGet } from './api.js';

// --- helpers ---------------------------------------------------------------

function slug(s) {
  return String(s || 'untitled')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function wordCount(content) {
  const words = String(content || '').trim().split(/\s+/).filter(Boolean);
  return words.length.toLocaleString('en-US');
}

// Relative time ("just now", "5m ago", "2h ago", "3d ago", "Jan 5").
function rel(updated) {
  if (!updated) return 'recently';
  const then = new Date(updated).getTime();
  if (!Number.isFinite(then)) return 'recently';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  try {
    return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch (_) {
    return `${days}d ago`;
  }
}

// Parse markdown-ish content into the mock's block shape.
//   `# ` / `## ` (any run of #) → { t: 'h', text }
//   `> `                       → { t: 'quote', text }
//   consecutive `- ` / `* `    → one { t: 'list', items: [...] }
//   blank-line-separated runs  → { t: 'p', text }
function parseBlocks(content) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];     // buffered plain-text lines for the current paragraph
  let list = null;   // buffered list items for the current list

  const flushPara = () => {
    if (para.length) {
      const text = para.join(' ').trim();
      if (text) blocks.push({ t: 'p', text });
      para = [];
    }
  };
  const flushList = () => {
    if (list && list.length) blocks.push({ t: 'list', items: list });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) { flushPara(); flushList(); continue; }

    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { flushPara(); flushList(); blocks.push({ t: 'h', text: h[1].trim() }); continue; }

    const q = line.match(/^>\s?(.*)$/);
    if (q) { flushPara(); flushList(); blocks.push({ t: 'quote', text: q[1].trim() }); continue; }

    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) { flushPara(); if (!list) list = []; list.push(li[1].trim()); continue; }

    // normal text line → accumulate into paragraph
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  return blocks;
}

// --- loader ----------------------------------------------------------------

export async function load(state) {
  const data = await apiGet('/api/notes');
  const raw = (data && data.notes) || data || [];
  const list = Array.isArray(raw) ? raw : [];

  const docs = list.map((note) => {
    const title = note.title || '(untitled)';
    return {
      title,
      path: note.path || `notes/${slug(note.title)}.md`,
      version: note.version || 1,
      meta: `Updated ${rel(note.updated)} · ${wordCount(note.content)} words`,
      blocks: parseBlocks(note.content),
      // retained for sorting; harmless extra fields on the mock shape
      _pinned: !!note.pinned,
      _updated: note.updated ? new Date(note.updated).getTime() || 0 : 0,
    };
  });

  // Pinned first, then most-recently-updated.
  docs.sort((a, b) => {
    if (a._pinned !== b._pinned) return a._pinned ? -1 : 1;
    return b._updated - a._updated;
  });

  state.live.notes = { docs };
}
