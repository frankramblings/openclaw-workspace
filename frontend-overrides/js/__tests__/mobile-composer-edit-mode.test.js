import { test } from 'node:test';
import assert from 'node:assert';
import { mChat } from '../redesign/mobile/mobile-surfaces.js';

const baseState = () => ({
  draft: '', pendingAttach: [], keyboard: false, refreshing: false, dismissed: [],
  mobileEditingPending: null,
  live: { chat: {
    thread: [],
    mobileSheetMsgId: null, msgMenuOpen: null,
    title: 't', endpointId: 'x', model: 'y',
  }, modelList: [] },
});

test('composer has no edit chip when mobileEditingPending is null', () => {
  const html = mChat(baseState());
  assert.doesNotMatch(html, /m-comp-edit-chip/);
});

test('send button has no editing class when mobileEditingPending is null', () => {
  const html = mChat(baseState());
  assert.doesNotMatch(html, /class="m-send editing"/);
});

test('composer renders edit chip when mobileEditingPending is set', () => {
  const s = baseState();
  s.mobileEditingPending = { originalMsgId: 'u1' };
  const html = mChat(s);
  assert.match(html, /m-comp-edit-chip/);
  assert.match(html, /Editing message/);
  assert.match(html, /data-act="cancelMobileEdit"/);
});

test('send button carries editing class + Save label when mobileEditingPending is set', () => {
  const s = baseState();
  s.mobileEditingPending = { originalMsgId: 'u1' };
  const html = mChat(s);
  assert.match(html, /class="m-send editing"/);
  assert.match(html, /class="m-send-lbl"[^>]*>Save/);
});
