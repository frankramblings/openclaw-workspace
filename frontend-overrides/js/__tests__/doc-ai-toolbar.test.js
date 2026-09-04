// Pillar C2: the dock's AI toolbar markup (desktop row + mobile kebab menu)
// and the pure action-resolution/force-attach rules it relies on.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.document = { querySelector: () => null };
globalThis.window = { addEventListener() {}, innerWidth: 1200, toastui: null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { aiToolbarHtml, aiKebabMenuHtml, resolveAiAction, consumeAttachDetach, libraryDocIdFor }
  = await import('../redesign/live/document-editor.js');
const { runtime } = await import('../redesign/live/runtime.js');

const ACT_NAMES = ['docAiSummarize', 'docAiRewrite', 'docAiContinue', 'docAiAsk'];

test('aiToolbarHtml: exactly the four AI actions, each a stable data-act, no em dash', () => {
  const html = aiToolbarHtml();
  for (const act of ACT_NAMES) assert.match(html, new RegExp(`data-act="${act}"`));
  assert.equal((html.match(/data-act="docAi/g) || []).length, 4);
  assert.ok(!html.includes('—'));
});

test('aiKebabMenuHtml: the same four actions, for the mobile dropdown, no em dash', () => {
  const html = aiKebabMenuHtml();
  for (const act of ACT_NAMES) assert.match(html, new RegExp(`data-act="${act}"`));
  assert.ok(!html.includes('—'));
});

test('resolveAiAction: Summarize/Continue/Rewrite dispatch to their builders; Ask sends nothing', () => {
  assert.match(resolveAiAction('docAiSummarize', null, ''), /5 to 8 bullets/);
  assert.match(resolveAiAction('docAiContinue', null, ''), /Continue writing/);
  assert.equal(resolveAiAction('docAiAsk', null, ''), null);
  assert.equal(resolveAiAction('docAiRewrite', null, 'body'), null); // nothing selected
  const md = 'line one\nline two\n';
  assert.match(resolveAiAction('docAiRewrite', { text: 'line one', from: 0, to: 8 }, md), /edit the file in place/);
});

test('force-attach rule: consumeAttachDetach re-enables attach even after the pill was detached', () => {
  const d = { open: true, id: 'doc-1', wsPath: null, attachDetached: true };
  runtime.state = { docEditor: d };
  assert.equal(libraryDocIdFor(d), null, 'detached: the normal send path would omit active_doc_id');
  consumeAttachDetach();
  assert.equal(d.attachDetached, false);
  assert.equal(libraryDocIdFor(d), 'doc-1', 'the toolbar force-attach step re-enables it for this send');
});
