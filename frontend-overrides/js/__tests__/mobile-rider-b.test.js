// RIDER B (5.7-mobile items):
//  - .m-conv-title was reused by both the chat header AND every drawer/
//    semantic-hit row. The two rules' declared properties didn't collide
//    (header: display/align-items/gap/max-width; drawer: flex/font-size/
//    color/white-space/overflow/text-overflow), so BOTH sets landed on
//    BOTH usages — a `flex:1` bled onto the header's flex-column child, and
//    the drawer row's ellipsis properties landed on a flex container
//    (text-overflow doesn't reliably truncate a flex formatting context,
//    and the row had no min-width:0 to let it shrink below content size in
//    the first place). Split into two classes.
//  - the toast dismiss ✕ was a <span data-act>, not a real button.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderConvDrawer } from '../redesign/mobile/mobile-sheets.js';
import { mChat, mToastHtml } from '../redesign/mobile/mobile-surfaces.js';

test('chat header keeps the original .m-conv-title flex wrapper', () => {
  const html = mChat({ live: { chat: { thread: [], title: 'Planning Q3' } }, draft: '' });
  assert.match(html, /<div class="m-conv-title"><span class="t">Planning Q3<\/span><\/div>/);
});

test('drawer conversation rows use a dedicated, non-flex ellipsis class', () => {
  const s = {
    mDrawerOpen: true, mDrawerSide: 'left', convFilter: '',
    live: { chat: { groups: [{ label: 'TODAY', rows: [{ id: '1', title: 'A very long conversation title that should truncate', active: false }] }] } },
  };
  const html = renderConvDrawer(s);
  assert.match(html, /class="m-conv-row-title"/);
  assert.doesNotMatch(html, /class="m-conv-title"/, 'the header-only class must not leak onto drawer rows');
});

test('toast dismiss is a real <button>, not a bare span', () => {
  const html = mToastHtml({ inboxToast: { msg: 'Refresh failed — showing cached data', undoTs: null } });
  assert.match(html, /<button[^>]*data-act="dismissToast"/);
  assert.doesNotMatch(html, /<span[^>]*data-act="dismissToast"/);
});

// The jump-to-latest button now lives INSIDE .m-composer and is anchored to
// the composer's top edge purely in the stylesheet (bottom:100%+gap). It must
// carry NO inline position at all — no `bottom`, no `--m-scroll-btm-y` var —
// so the stylesheet fully owns where it sits (above the composer, clear of
// Send in every state, no guessed screen-bottom offset to overlap chrome).
test('jump-to-latest button carries no inline position (stylesheet-anchored above composer)', () => {
  const html = mChat({ live: { chat: { thread: [] } }, draft: '' });
  const btn = html.match(/<button class="m-scroll-btm"[^>]*>/)[0];
  assert.doesNotMatch(btn, /style="[^"]*\bbottom:/, 'no inline `bottom` declaration');
  assert.doesNotMatch(btn, /--m-scroll-btm-y:/, 'no leftover position custom property');
});

// It renders as a child of the composer (not a loose sibling) so it can anchor
// to the composer's top edge and lift with it when the keyboard is up.
test('jump-to-latest button renders inside .m-composer', () => {
  const html = mChat({ live: { chat: { thread: [] } }, draft: '' });
  const composerAt = html.indexOf('class="m-composer');
  const btnAt = html.indexOf('class="m-scroll-btm"');
  assert.ok(composerAt !== -1 && btnAt > composerAt, 'button appears after the composer open tag');
});
