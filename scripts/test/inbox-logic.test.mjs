import assert from 'node:assert/strict';
import {
  srcStyle,
  actionLabel,
  cardActions,
  isInvite,
  filterVisible,
  sourceCounts,
  openUrlFor,
} from '../../frontend-overrides/js/redesign/live/inbox-logic.js';

// --- srcStyle: all five real sources are styled, unknown falls back ---------
assert.equal(srcStyle('gmail').srcColor, 'var(--red)');
assert.equal(srcStyle('GMAIL').srcColor, 'var(--red)');   // case-insensitive
assert.equal(srcStyle('slack').srcColor, 'var(--green)');
assert.equal(srcStyle('asana').srcColor, 'var(--gold)');
assert.ok(srcStyle('obsidian').srcColor, 'obsidian is styled');
assert.ok(srcStyle('documents').srcColor, 'documents is styled');
assert.notEqual(srcStyle('obsidian').srcColor, srcStyle('asana').srcColor,
  'obsidian distinct from asana');
assert.equal(srcStyle('mystery').srcColor, 'var(--muted)', 'unknown → muted');

// --- actionLabel: backend action verbs map to human labels ------------------
assert.equal(actionLabel('archive'), 'Archive');
assert.equal(actionLabel('delete'), 'Delete');
assert.equal(actionLabel('mark_read'), 'Mark read');
assert.equal(actionLabel('complete'), 'Complete');
assert.equal(actionLabel('reviewed'), 'Reviewed');
assert.equal(actionLabel('dismiss'), 'Dismiss');
assert.equal(actionLabel('snooze'), 'Snooze');
assert.equal(actionLabel('open'), 'Open');
assert.equal(actionLabel('gary'), 'Hand to __AGENT_NAME__');
assert.equal(actionLabel('weird_thing'), 'Weird thing',
  'unknown verb → humanized fallback');

// --- cardActions: derive ordered buttons from the backend actions[] ---------
// Gmail: archive is the primary clear-action; delete is a secondary; dismiss
// becomes the ✕ (not a row button); snooze/open/gary are universal affordances.
const gmail = cardActions({ source: 'gmail', actions: ['archive', 'delete', 'dismiss', 'snooze'] });
const gPrimary = gmail.find((a) => a.role === 'primary');
assert.equal(gPrimary.action, 'archive', 'gmail primary = archive');
assert.equal(gPrimary.label, 'Archive');
assert.ok(gmail.some((a) => a.action === 'delete' && a.role === 'overflow'),
  'gmail delete is an overflow button');
assert.ok(!gmail.some((a) => a.action === 'dismiss' && a.role !== 'x'),
  'dismiss is not a normal row button');

// Slack: mark_read is primary.
const slack = cardActions({ source: 'slack', actions: ['mark_read', 'dismiss', 'snooze'] });
assert.equal(slack.find((a) => a.role === 'primary').action, 'mark_read');

// Asana: complete is primary.
const asana = cardActions({ source: 'asana', actions: ['complete', 'dismiss', 'snooze'] });
assert.equal(asana.find((a) => a.role === 'primary').action, 'complete');

// Obsidian: add_asana is primary (capture the commitment as a task); complete
// and reviewed demote to secondary ghost buttons.
const obs = cardActions({ source: 'obsidian', actions: ['add_asana', 'complete', 'reviewed', 'dismiss', 'snooze'] });
assert.equal(obs.find((a) => a.role === 'primary').action, 'add_asana',
  'obsidian primary = add_asana');
assert.ok(obs.some((a) => a.action === 'complete' && a.role === 'overflow'),
  'complete is a secondary overflow button');
assert.ok(obs.some((a) => a.action === 'reviewed' && a.role === 'overflow'),
  'reviewed is now a secondary overflow button');

// Documents: no clear-verb → no primary, but still has gary + open + dismiss(✕).
const docs = cardActions({ source: 'documents', actions: ['dismiss', 'snooze'] });
assert.equal(docs.find((a) => a.role === 'primary'), undefined,
  'documents has no primary clear-action');
assert.ok(docs.some((a) => a.action === 'gary'), 'gary always offered');

// Missing actions[] must not throw and must still offer gary.
const bare = cardActions({ source: 'slack' });
assert.ok(Array.isArray(bare));
assert.ok(bare.some((a) => a.action === 'gary'));

// Calendar invite: Yes / Maybe / No replace the clear-verb, write the RSVP.
const invite = cardActions({ source: 'calendar', actions: ['rsvp', 'dismiss', 'snooze'] });
assert.equal(invite.find((a) => a.role === 'primary').action, 'rsvpYes', 'Yes is the primary RSVP');
assert.deepEqual(invite.filter((a) => a.action.startsWith('rsvp')).map((a) => a.action),
  ['rsvpYes', 'rsvpMaybe', 'rsvpNo'], 'three RSVP buttons in order');
assert.ok(invite.some((a) => a.action === 'gary'), 'invite still offers hand-to-gary');
assert.ok(!invite.some((a) => a.role === 'x'), 'invite has no row ✕ (dismiss is the corner X)');
// isInvite via meta flag also triggers the RSVP layout, even without actions[].
const inviteByMeta = cardActions({ source: 'gmail', meta: { isInvite: true } });
assert.equal(inviteByMeta.find((a) => a.role === 'primary').action, 'rsvpYes',
  'meta.isInvite alone triggers RSVP buttons');

// isInvite detection (used by mobile swipe guard + render): source/action/meta.
assert.ok(isInvite({ source: 'calendar' }), 'calendar source is an invite');
assert.ok(isInvite({ source: 'gmail', actions: ['rsvp'] }), 'rsvp action marks an invite');
assert.ok(isInvite({ meta: { isInvite: true } }), 'meta.isInvite marks an invite');
assert.ok(!isInvite({ source: 'gmail', actions: ['archive'] }), 'plain gmail is not an invite');
assert.ok(!isInvite({}), 'empty item is not an invite');

// --- filterVisible: dismissed hidden, source filter applied -----------------
const items = [
  { id: '1', src: 'GMAIL' },
  { id: '2', src: 'SLACK' },
  { id: '3', src: 'GMAIL' },
];
assert.equal(filterVisible(items, { dismissed: ['2'], filter: null }).length, 2,
  'dismissed item hidden, no source filter');
assert.deepEqual(
  filterVisible(items, { dismissed: [], filter: 'GMAIL' }).map((i) => i.id),
  ['1', '3'], 'source filter keeps only matching');
assert.equal(
  filterVisible(items, { dismissed: ['1'], filter: 'GMAIL' }).length, 1,
  'filter + dismissed compose');
assert.equal(filterVisible(items, {}).length, 3, 'no opts → all visible');

// --- sourceCounts: prefer backend sources map, fall back to visible count ---
const counts = sourceCounts(items, { dismissed: [], filter: null }, { gmail: 9, slack: 4 });
assert.equal(counts.GMAIL, 9, 'backend count wins when present');
assert.equal(counts.SLACK, 4);
assert.equal(counts.all, 3, 'all = visible length');
const noBackend = sourceCounts(items, { dismissed: ['2'], filter: null }, null);
assert.equal(noBackend.GMAIL, 2, 'fallback counts visible by src');
assert.equal(noBackend.all, 2);

// --- openUrlFor: returns meta.url when present, null otherwise ---------------
assert.equal(openUrlFor({ meta: { url: 'https://app.asana.com/x' } }), 'https://app.asana.com/x');
assert.equal(openUrlFor({ source: 'gmail', meta: {} }), null, 'gmail resolves async, not here');
assert.equal(openUrlFor({}), null);

// --- cardButtonsHtml: renders real per-action data-act, not hardcoded dismiss ---
import { cardButtonsHtml } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
const idEsc = (x) => String(x);
const html = cardButtonsHtml(
  { id: 'a1', source: 'gmail', actions: ['archive', 'delete', 'dismiss', 'snooze'] }, idEsc);
assert.ok(html.includes('data-act="archive"'), 'primary archive button present');
assert.ok(html.includes('data-act="toggleMore"'), '⋯ More toggle present (delete now lives in overflow)');
assert.ok(!html.includes('data-act="delete"'), 'delete is collapsed into overflow, not in the default row');
assert.ok(html.includes('data-act="open"'), 'open affordance present');
assert.ok(html.includes('data-act="snooze"'), 'snooze affordance present');
assert.ok(html.includes('data-act="gary"'), 'hand-to-gary affordance present');
assert.ok(!html.includes('data-act="dismiss"'),
  'dismiss ✕ is NOT in the action row — it lives as the top-right card ✕, no duplicate');
assert.ok(html.includes('data-arg="a1"'), 'every button carries the item id');
assert.ok(!/data-act="dismiss"[^>]*>Archive/.test(html), 'Archive is not wired to dismiss');

// --- chipRowHtml: interactive source-filter chips with error badges -----------
import { chipRowHtml } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
const chips = chipRowHtml(
  { all: 5, GMAIL: 3, SLACK: 2, OBSIDIAN: 1 },
  { filter: 'GMAIL', errors: { slack: 'timeout' } },
  (x) => String(x));
assert.ok(chips.includes('data-act="setFilter"'), 'chips are clickable');
assert.ok(chips.includes('data-arg="ALL"'), 'All chip present');
assert.ok(chips.includes('data-arg="OBSIDIAN"'), 'obsidian chip present');
assert.ok(/data-arg="GMAIL"[^>]*class="[^"]*active/.test(chips) ||
          /class="[^"]*active[^"]*"[^>]*data-arg="GMAIL"/.test(chips),
  'active class on the filtered chip');
assert.ok(chips.includes('⚠'), 'error badge shown for slack');

// --- dueChipToISO: maps Add-to-Asana date chips to ISO YYYY-MM-DD ----------
import { dueChipToISO } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
const MON = Date.UTC(2026, 5, 29, 12, 0, 0); // 2026-06-29 is a Monday (UTC noon)
assert.equal(dueChipToISO('today', MON), '2026-06-29');
assert.equal(dueChipToISO('tomorrow', MON), '2026-06-30');
assert.equal(dueChipToISO('fri', MON), '2026-07-03', 'next Friday from Mon');
assert.equal(dueChipToISO('nextweek', MON), '2026-07-06', 'next Monday');
assert.equal(dueChipToISO('none', MON), null);

// Obsidian primary becomes Add to Asana (not Reviewed) when add_asana is allowed.
const obsA = cardActions({ source: 'obsidian', actions: ['add_asana', 'reviewed', 'dismiss', 'snooze'] });
const obsPrim = obsA.find((a) => a.role === 'primary');
assert.equal(obsPrim.action, 'add_asana', 'obsidian primary = add to asana');
assert.equal(obsPrim.label, 'Add to Asana');
// reviewed is now available as an overflow item.
assert.ok(obsA.some((a) => a.action === 'reviewed' && a.role === 'overflow'));

// --- snoozeUntilMs: preset snooze epoch-ms relative to nowMs ----------------
import { snoozeUntilMs } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
const base = Date.UTC(2026, 5, 29, 12, 0, 0);
assert.ok(snoozeUntilMs('later', base) > base, 'later today is in the future');
assert.equal(new Date(snoozeUntilMs('tomorrow', base)).getUTCDate(), 30, 'tomorrow → next day');
assert.ok(snoozeUntilMs('nextweek', base) - base >= 6.5 * 86400000, 'nextweek ≥ ~7 days');

// --- swipeIntent: gesture classification for mobile swipe actions -----------
import { swipeIntent } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';
assert.equal(swipeIntent(100, 360), 'primary',  'right swipe >84 → primary');
assert.equal(swipeIntent(-150, 360), 'snooze',  'left swipe <-140 → snooze');
assert.equal(swipeIntent(-100, 360), 'dismiss', 'left swipe -84..-140 → dismiss');
assert.equal(swipeIntent(-40, 360), null,        'small left swipe → null');
assert.equal(swipeIntent(40, 360), null,         'small right swipe → null');

// --- Phase 1: secondaries move to overflow, main row is invariant ---
{
  const gmail = cardActions({ source: 'gmail', actions: ['archive', 'delete', 'dismiss', 'snooze'] });
  assert.ok(gmail.some((a) => a.action === 'delete' && a.role === 'overflow'),
    'gmail delete is now an overflow item, not a row ghost');
  assert.ok(!gmail.some((a) => a.role === 'ghost'),
    'non-invite cards emit no ghost role (secondaries are overflow)');

  const obs = cardActions({ source: 'obsidian', actions: ['add_asana', 'complete', 'reviewed', 'dismiss', 'snooze'] });
  const obsPrimary = obs.find((a) => a.role === 'primary');
  assert.equal(obsPrimary.action, 'add_asana', 'obsidian primary stays add_asana');
  const obsOverflow = obs.filter((a) => a.role === 'overflow').map((a) => a.action);
  assert.deepEqual(obsOverflow, ['complete', 'reviewed'], 'obsidian complete+reviewed go to overflow in order');

  // Invariant main row: exactly one primary + the icon affordances, no ghost/overflow inline.
  const rowRoles = gmail.filter((a) => a.role === 'primary' || a.role === 'icon').map((a) => a.action);
  assert.deepEqual(rowRoles, ['archive', 'open', 'snooze', 'gary'], 'gmail main row is Primary+open+snooze+gary');
}

// --- Phase 1: cardButtonsHtml renders ⋯ toggle + collapsible overflow ---
{
  const esc = (x) => String(x);
  const item = { id: 'g1', source: 'gmail', actions: ['archive', 'delete', 'dismiss', 'snooze'] };
  const collapsed = cardButtonsHtml(item, esc);
  assert.ok(collapsed.includes('data-act="toggleMore"'), 'renders a ⋯ More toggle when overflow exists');
  assert.ok(!collapsed.includes('data-act="delete"'), 'overflow (delete) hidden while collapsed');

  const open = cardButtonsHtml(item, esc, { moreOpen: true });
  assert.ok(open.includes('data-act="delete"'), 'overflow (delete) shown when moreOpen');
  assert.ok(open.includes('card-overflow'), 'overflow buttons live in a .card-overflow group');

  const noOverflow = cardButtonsHtml({ id: 's1', source: 'slack', actions: ['mark_read', 'dismiss', 'snooze'] }, esc);
  assert.ok(!noOverflow.includes('data-act="toggleMore"'), 'no ⋯ toggle when there is nothing to overflow');
}

console.log('inbox-logic: all assertions OK');
