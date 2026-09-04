// LIBRARY surface — compose real artifacts from research + documents + notes.
// Renders via `state.live.library.items` (mock fallback in surfaces.js:
// `s.live?.library?.items ?? LIBRARY`). Filter chips are wired client-side by
// `cat`. This module's only action of its own is clipUrl (Task C3) --
// everything else it exposes is document-editor's.
//
// Mock item shape (data.js LIBRARY):
//   { title, kind:'REPORT'|'DOC'|'NOTE'|'CODE',
//     kindLabel:'VISUAL REPORT'|'DOCUMENT'|'NOTE'|'SNIPPET',
//     when, cat:'report'|'doc'|'note'|'code' }

import { apiGet, apiJson } from './api.js';
import { actions as docActions, initDocEditor } from './document-editor.js';
import { humanizeTitle, contentSnippet } from './library-logic.js';
import { toast } from './chat.js';
import { clipErrorMessage, clipResultVerb } from '../clip-core.js';

// Fix round 1 (review, Important 1): in-flight guard for the Library "Clip
// URL" button -- same reasoning as app.js's _clipDraftInFlight (see its
// comment): without this, a second click while a POST /api/clip is still
// pending fires its own concurrent request for the same URL. Checked and
// set synchronously before the POST, cleared in `finally`.
let _clipUrlInFlight = false;

// Library exposes the document-editor actions (newDoc / openDoc / saveDoc / closeDoc)
// plus clipUrl (Task C3).
export const actions = {
  ...docActions,
  // Library "Clip URL": a one-field prompt, then open the new document --
  // same shape as newDoc's "create, then open" flow just above it. Success
  // toasts "Updated: <title>" instead of "Clipped: <title>" (clipResultVerb,
  // clip-core.js) when the response's document.version_count is >1.
  clipUrl: async () => {
    if (_clipUrlInFlight) return;
    let url = '';
    try { url = (window.prompt('Paste a URL to clip') || '').trim(); } catch (_) { return; }
    if (!url) return;
    _clipUrlInFlight = true;
    try {
      const res = await apiJson('/api/clip', { url });
      if (res && res.document && res.document.id) await docActions.openDoc(res.document.id);
      const title = (res && res.document && res.document.title) || 'document';
      toast(`${clipResultVerb(res && res.document)}: ${title}`);
    } catch (e) {
      // Final review, Minor 11: this used to be a window.alert, while the
      // composer chip and the deep link both raise a toast for exactly the
      // same failures. One modal in three otherwise identical paths is just
      // an inconsistency, so all three toast now.
      toast(clipErrorMessage(e));
    } finally {
      _clipUrlInFlight = false;
    }
  },
};
let editorInited = false;

// Fetch/render cap — exported so surfaces.js can render an honest "showing
// first N — refine to see more" footer when the list comes back exactly at
// the cap (task 6.2 — disclosure only, no pagination).
export const CAP = 30;

// Languages that should render as a code SNIPPET rather than a DOCUMENT.
const CODE_LANGS = new Set([
  'js', 'javascript', 'jsx', 'mjs', 'cjs',
  'ts', 'typescript', 'tsx',
  'py', 'python',
  'go', 'golang',
  'rust', 'rs',
  'c', 'h',
  'cpp', 'c++', 'cc', 'cxx', 'hpp',
  'java', 'kotlin', 'kt', 'scala',
  'sh', 'bash', 'zsh', 'shell',
  'sql',
  'json', 'yaml', 'yml', 'toml',
  'html', 'htm', 'xml',
  'css', 'scss', 'sass', 'less',
  'rb', 'ruby', 'php', 'swift', 'cs', 'csharp',
  'lua', 'perl', 'pl', 'r', 'dart', 'vue', 'svelte',
]);

function isCodeLang(language) {
  if (!language) return false;
  return CODE_LANGS.has(String(language).trim().toLowerCase());
}

// Coerce a timestamp into epoch-milliseconds. Accepts unix seconds (number or
// numeric string) and ISO-8601 strings. Returns 0 on anything unparseable so
// such items sort to the bottom rather than crashing the sort.
function toMs(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const s = String(ts).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Relative label: "just now" / "Nm" / "Nh" / "Nd" / "Nw".
function relativeWhen(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function asArray(raw, key) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw[key])) return raw[key];
  return [];
}

async function safe(fn) {
  try {
    return { items: await fn(), ok: true };
  } catch (e) {
    return { items: [], ok: false, error: e };
  }
}

// Titles run through humanizeTitle (task 5.4): raw ALLCAPS/dash filenames
// display as words (MARISSA-BETA-RUNBOOK → Marissa Beta Runbook); anything
// already mixed-case — research queries, typed titles — passes through
// untouched. `snippet` feeds the card thumbnail where the list API carries
// content (documents `preview`, notes `content`); research runs have none,
// so their cards fall back to the kind-icon thumb.
async function loadResearch() {
  const raw = await apiGet('/api/research/library?limit=30');
  return asArray(raw, 'research').map((r) => ({
    title: humanizeTitle(r.query || r.title || 'Untitled research'),
    kind: 'REPORT',
    kindLabel: 'VISUAL REPORT',
    cat: 'report',
    _ts: toMs(r.started_at),
  }));
}

async function loadDocuments() {
  const raw = await apiGet('/api/documents/library?sort=recent&limit=30');
  return asArray(raw, 'documents').map((d) => {
    const code = isCodeLang(d.language);
    return {
      id: d.id,
      title: humanizeTitle(d.title || 'Untitled document'),
      kind: code ? 'CODE' : 'DOC',
      kindLabel: code ? 'SNIPPET' : 'DOCUMENT',
      cat: code ? 'code' : 'doc',
      snippet: contentSnippet(d.preview),
      _ts: toMs(d.updated_at),
    };
  });
}

async function loadNotes() {
  const raw = await apiGet('/api/notes');
  return asArray(raw, 'notes').map((n) => ({
    title: humanizeTitle(n.title || 'Untitled note'),
    kind: 'NOTE',
    kindLabel: 'NOTE',
    cat: 'note',
    snippet: contentSnippet(n.content),
    _ts: toMs(n.updated),
  }));
}

// Populate state.live.library in the mock's shape. Each source is fetched
// independently so one failure doesn't sink the rest; if ALL three fail we
// throw to keep the mock in place.
export async function load(state) {
  if (!editorInited) { try { initDocEditor(); } catch (_) {} editorInited = true; }
  const [research, documents, notes] = await Promise.all([
    safe(loadResearch),
    safe(loadDocuments),
    safe(loadNotes),
  ]);

  if (!research.ok && !documents.ok && !notes.ok) {
    throw new Error('library: all sources failed (research/documents/notes)');
  }

  const items = [...research.items, ...documents.items, ...notes.items]
    .sort((a, b) => b._ts - a._ts)
    .slice(0, CAP)
    .map(({ _ts, ...rest }) => ({ ...rest, when: relativeWhen(_ts) }));

  state.live = state.live || {};
  state.live.library = { items };

  // eslint-disable-next-line no-console
  console.info(
    `[live/library] research=${research.items.length}${research.ok ? '' : '(failed)'} ` +
    `documents=${documents.items.length}${documents.ok ? '' : '(failed)'} ` +
    `notes=${notes.items.length}${notes.ok ? '' : '(failed)'} → ${items.length} items`,
  );
}
