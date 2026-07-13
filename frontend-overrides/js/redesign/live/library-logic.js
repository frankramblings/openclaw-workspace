// Pure display helpers for the LIBRARY surface (task 5.4). No DOM, no fetch —
// library.js (load-time mapping) and unit tests import these; live/api.js
// touches `location` at module scope, so anything test-importable must stay
// out of library.js itself.

// Humanize filename-style titles for display: PROPOSAL → Proposal,
// MARISSA-BETA-RUNBOOK → Marissa Beta Runbook. Only names that read as
// filenames are rewritten — ALL-CAPS/digits with -/_/space separators and no
// lowercase anywhere; anything mixed-case was typed that way on purpose.
// Acronym-ish short tokens (API, RSS, AI ≤3 chars) and digit-bearing tokens
// (Q3, V2) keep their case; runs of numeric tokens re-join with dashes so
// dates (2026-07-01) survive the separator split intact.
export function humanizeTitle(raw) {
  const t = String(raw || '').trim();
  if (!t) return t;
  if (/[a-z]/.test(t) || !/[A-Z]/.test(t)) return t;
  const rawTokens = t.split(/[-_\s]+/).filter(Boolean);
  const tokens = [];
  let numRun = [];
  const flush = () => {
    if (!numRun.length) return;
    tokens.push(numRun.length > 1 ? numRun.join('-') : numRun[0]);
    numRun = [];
  };
  for (const w of rawTokens) {
    if (/^\d+$/.test(w)) { numRun.push(w); continue; }
    flush();
    tokens.push(w);
  }
  flush();
  return tokens.map((w) => {
    if (/\d/.test(w)) return w;   // dates, Q3, V2 — keep as-is
    if (w.length <= 3) return w;  // acronym-ish: API, RSS, AI
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join(' ');
}

// First lines of an artifact's content for the card thumbnail: markdown
// heading markers stripped, blank lines dropped, capped so the card's
// line-clamp does the visual truncation on something already short.
export function contentSnippet(text, maxLen = 200) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return '';
  const lines = t.split('\n')
    .map((l) => l.replace(/^#{1,6}\s*/, '').trim())
    .filter(Boolean);
  let out = lines.slice(0, 4).join('\n');
  if (out.length > maxLen) out = out.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
  return out;
}
