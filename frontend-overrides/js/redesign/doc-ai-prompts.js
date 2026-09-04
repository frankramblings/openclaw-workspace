// Pure prompt builders for the document dock's AI actions (Pillar C2:
// in-document AI over draft mode, spec §2.2). DOM-free: callers pass in
// whatever context they already have (documentEditor.getSelection(),
// editor.getMarkdown()), same posture as live/suggest-core.js.
//
// Summarize and Continue are one-shot templates. Rewrite needs the current
// selection and returns null when there isn't one; the caller (the dock
// toolbar, Task 5) shows a "select some text first" notice instead of
// sending. Ask has no template: ASK_PLACEHOLDER is just a composer hint,
// the user types the actual question, which travels through the normal
// send path with active_doc_id attached like any other message.

export const ASK_PLACEHOLDER = 'Ask about this document';

export function buildSummarizePrompt() {
  return 'Summarize the open document in 5 to 8 bullets, then list open questions. Do not edit the file.';
}

export function buildContinuePrompt() {
  return 'Continue writing from the end of the document in the same voice for two or three paragraphs; append to the file.';
}

// 1-based line number a character offset falls on, counting '\n' up to pos.
function lineAt(markdown, pos) {
  const clamped = Math.max(0, Math.min(pos, markdown.length));
  return markdown.slice(0, clamped).split('\n').length;
}

// Character-offset selection range -> {start, end} 1-based line numbers.
// Pure, independent of buildRewritePrompt. Tolerates a reversed range and
// null offsets (treated as 0).
export function lineRangeFor(markdown, from, to) {
  const text = String(markdown || '');
  const a = Number.isInteger(from) ? from : 0;
  const b = Number.isInteger(to) ? to : a;
  return { start: lineAt(text, Math.min(a, b)), end: lineAt(text, Math.max(a, b)) };
}

export function buildRewritePrompt(selection, markdown) {
  const text = selection && typeof selection.text === 'string' ? selection.text.trim() : '';
  if (!text) return null; // nothing selected: caller asks the user to select first
  const hasRange = selection && Number.isInteger(selection.from) && Number.isInteger(selection.to);
  const where = hasRange
    ? (() => {
        const { start, end } = lineRangeFor(markdown, selection.from, selection.to);
        return `the selected passage (lines ${start}..${end}, quoted below)`;
      })()
    : 'the selected passage (quoted below)';
  return `Rewrite ${where} for clarity; edit the file in place and keep everything else unchanged.\n\n`
    + `── selection ──\n${selection.text}\n── end selection ──`;
}
