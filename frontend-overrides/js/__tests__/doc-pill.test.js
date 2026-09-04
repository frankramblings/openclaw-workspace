// Fix wave, M2: the composer's "Editing" pill and the attach rule behind it
// used to be re-implemented inline in surfaces.js and mobile-surfaces.js.
// One owner now, so these tests are the whole contract for both shells.
import { test } from 'node:test';
import assert from 'node:assert';

const { docPillHtml, libraryDocIdFor } = await import('../redesign/doc-pill.js');

const buf = (over) => Object.assign({
  open: true, id: 'doc-1', title: 'Launch plan',
  wsPath: null, readOnly: false, loadFailed: false, attachDetached: false,
}, over);

test('libraryDocIdFor: only an open, loaded, writable, attached Library doc', () => {
  assert.equal(libraryDocIdFor(buf()), 'doc-1');
  assert.equal(libraryDocIdFor(null), null);
  assert.equal(libraryDocIdFor(buf({ open: false })), null);
  assert.equal(libraryDocIdFor(buf({ id: null })), null);
  assert.equal(libraryDocIdFor(buf({ wsPath: 'notes/a.md' })), null, 'a workspace file is not a Library doc');
  assert.equal(libraryDocIdFor(buf({ attachDetached: true })), null);
  assert.equal(libraryDocIdFor(buf({ loadFailed: true })), null, 'nothing to attach if the buffer never loaded');
  assert.equal(libraryDocIdFor(buf({ readOnly: true })), null);
});

test('docPillHtml: nothing rendered when nothing would be attached', () => {
  assert.equal(docPillHtml({}, { cls: 'oc-doc-pill' }), '');
  assert.equal(docPillHtml({ docEditor: buf({ attachDetached: true }) }, { cls: 'm-doc-pill' }), '');
});

test('docPillHtml: desktop markup keeps its class, role, title and detach action', () => {
  const html = docPillHtml({ docEditor: buf() }, { cls: 'oc-doc-pill', role: true, title: true });
  assert.match(html, /class="oc-doc-pill" role="status"/);
  assert.match(html, /<b>Launch plan<\/b>/);
  assert.match(html, /class="oc-doc-pill-x" data-act="detachDocPill"/);
  assert.match(html, /title="Stop attaching this document to your next message"/);
  assert.match(html, /aria-label="Stop attaching this document"/);
  assert.ok(!html.includes('—'), 'no em dash in UI copy');
});

test('docPillHtml: mobile markup drops the desktop-only attributes', () => {
  const html = docPillHtml({ docEditor: buf() }, { cls: 'm-doc-pill' });
  assert.match(html, /class="m-doc-pill"/);
  assert.ok(!html.includes('role="status"'));
  assert.ok(!html.includes('title="Stop'));
  assert.match(html, /class="m-doc-pill-x"/);
});

test('docPillHtml: an untitled document falls back to a label, and titles are escaped', () => {
  assert.match(docPillHtml({ docEditor: buf({ title: '' }) }, {}), /<b>Untitled document<\/b>/);
  assert.match(docPillHtml({ docEditor: buf({ title: '<script>x</script>' }) }, {}), /&lt;script&gt;/);
});
