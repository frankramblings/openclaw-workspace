// Task 4.2 — composer attachment upload lifecycle.
// Before: chips only appeared AFTER the upload fetch resolved, failures
// vanished silently, and a Send racing a slow upload silently went out
// without the file. Now: a chip appears at selection ('uploading', spinner),
// failure flips it red + removable, and send() gates on pending uploads.
// Pure decisions live in live/attach-logic.js; both shells' chip renderers
// reflect the status.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  beginUploads, resolveUploads, failUploads, sendableAttach, uploadGate,
} from '../redesign/live/attach-logic.js';
import { mChat } from '../redesign/mobile/mobile-surfaces.js';
import { renderCenter } from '../redesign/surfaces.js';

// ---- pure helpers -----------------------------------------------------------

const mintSeq = () => { let n = 0; return () => `tmp-${n++}`; };

test('beginUploads appends an uploading chip per file, preserving existing chips', () => {
  const { list, ids } = beginUploads(
    [{ id: 'real-1', name: 'done.pdf', url: '/u/real-1' }],
    ['a.png', 'b.txt'], mintSeq());
  assert.equal(list.length, 3);
  assert.deepEqual(ids, ['tmp-0', 'tmp-1']);
  assert.deepEqual(list[0], { id: 'real-1', name: 'done.pdf', url: '/u/real-1' });
  assert.deepEqual(list[1], { id: 'tmp-0', name: 'a.png', status: 'uploading' });
  assert.deepEqual(list[2], { id: 'tmp-1', name: 'b.txt', status: 'uploading' });
});

test('resolveUploads swaps uploading chips for saved files in order', () => {
  const pending = [
    { id: 'tmp-0', name: 'a.png', status: 'uploading' },
    { id: 'tmp-1', name: 'b.txt', status: 'uploading' },
  ];
  const out = resolveUploads(pending, ['tmp-0', 'tmp-1'], [
    { id: 's1', name: 'a.png', url: '/u/s1' },
    { id: 's2', name: 'b.txt', url: '/u/s2' },
  ]);
  assert.deepEqual(out, [
    { id: 's1', name: 'a.png', url: '/u/s1' },
    { id: 's2', name: 'b.txt', url: '/u/s2' },
  ]);
});

test('resolveUploads drops the saved record of a chip the user removed mid-flight', () => {
  // User hit ✕ on tmp-0 while the batch was uploading: only tmp-1 remains.
  const pending = [{ id: 'tmp-1', name: 'b.txt', status: 'uploading' }];
  const out = resolveUploads(pending, ['tmp-0', 'tmp-1'], [
    { id: 's1', name: 'a.png', url: '/u/s1' },
    { id: 's2', name: 'b.txt', url: '/u/s2' },
  ]);
  assert.deepEqual(out, [{ id: 's2', name: 'b.txt', url: '/u/s2' }],
    'the removed chip must not resurrect; the remaining chip gets ITS OWN saved record');
});

test('resolveUploads marks chips the server did not save as failed, never vanished', () => {
  const pending = [
    { id: 'tmp-0', name: 'a.png', status: 'uploading' },
    { id: 'tmp-1', name: 'b.txt', status: 'uploading' },
  ];
  const out = resolveUploads(pending, ['tmp-0', 'tmp-1'],
    [{ id: 's1', name: 'a.png', url: '/u/s1' }]);
  assert.deepEqual(out[0], { id: 's1', name: 'a.png', url: '/u/s1' });
  assert.equal(out[1].status, 'failed');
  assert.equal(out[1].name, 'b.txt');
});

test('failUploads flips only the batch chips to failed', () => {
  const out = failUploads([
    { id: 'real-1', name: 'done.pdf', url: '/u/real-1' },
    { id: 'tmp-0', name: 'a.png', status: 'uploading' },
  ], ['tmp-0']);
  assert.equal(out[0].status, undefined);
  assert.equal(out[1].status, 'failed');
});

test('uploadGate: uploading wins over failed; empty/resolved is ok', () => {
  assert.equal(uploadGate([]), 'ok');
  assert.equal(uploadGate(undefined), 'ok');
  assert.equal(uploadGate([{ id: 'a', name: 'x' }]), 'ok');
  assert.equal(uploadGate([{ id: 'a', status: 'failed' }]), 'failed');
  assert.equal(uploadGate([
    { id: 'a', status: 'failed' }, { id: 'b', status: 'uploading' },
  ]), 'uploading');
});

test('sendableAttach keeps only resolved uploads', () => {
  const snap = sendableAttach([
    { id: 'real-1', name: 'done.pdf', url: '/u/real-1' },
    { id: 'tmp-0', name: 'a.png', status: 'uploading' },
    { id: 'tmp-1', name: 'b.txt', status: 'failed' },
  ]);
  assert.deepEqual(snap.map((a) => a.id), ['real-1']);
});

// ---- renderers (both shells) ------------------------------------------------

const mState = (pendingAttach) => ({
  draft: '', pendingAttach, keyboard: false, refreshing: false, dismissed: [],
  mobileEditingPending: null,
  live: { chat: { thread: [], mobileSheetMsgId: null, title: 't', endpointId: 'x', model: 'y' }, modelList: [] },
});

test('mobile chip: uploading state shows a spinner, failed state is flagged and removable', () => {
  const up = mChat(mState([{ id: 'tmp-0', name: 'a.png', status: 'uploading' }]));
  assert.match(up, /m-attach-chip uploading/);
  assert.match(up, /fl-svg/, 'uploading chip carries the fortress spinner');
  const failed = mChat(mState([{ id: 'tmp-0', name: 'a.png', status: 'failed' }]));
  assert.match(failed, /m-attach-chip failed/);
  assert.match(failed, /data-act="removeAttach" data-arg="tmp-0"/, 'failed chip is removable');
});

const dState = (pendingAttach) => ({
  surface: 'chat', draft: '', pendingAttach, dismissed: [],
  live: { chat: { thread: [], title: 't', endpointId: 'x', model: 'y' }, modelList: [] },
});

test('desktop chip: uploading state shows a spinner, failed state is flagged and removable', () => {
  const up = renderCenter(dState([{ id: 'tmp-0', name: 'a.png', status: 'uploading' }]));
  assert.match(up, /atch-uploading/);
  assert.match(up, /fl-svg/, 'uploading chip carries the fortress spinner');
  assert.doesNotMatch(up, /atch-img/, 'an in-flight image must not render an <img> against a temp id');
  const failed = renderCenter(dState([{ id: 'tmp-0', name: 'a.png', status: 'failed' }]));
  assert.match(failed, /atch-failed/);
  assert.match(failed, /data-act="removeAttach" data-arg="tmp-0"/, 'failed chip is removable');
});
