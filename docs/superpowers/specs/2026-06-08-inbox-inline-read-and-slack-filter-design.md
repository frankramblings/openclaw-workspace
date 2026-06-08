# Inbox: open-in-place + Slack signal filtering — design

**Date:** 2026-06-08
**Status:** approved (brainstorm), ship in slices

## Problem

Three (now five) inbox asks from the user:

1. Clicking any inbox item should **open it in place** — read the email, see the
   calendar-invite details, see the Asana comment, read the Slack message/thread —
   instead of only revealing per-card actions.
2. Slack items should be **limited to signal**: where I'm @-tagged (incl.
   @here/@channel/usergroups I'm in) and threads I've participated in / am
   subscribed to and haven't unsubscribed from. Drop the unread firehose.
3. The `↗` **Open** button should open the deep-link in my **normal/last-used
   browser**, not trapped in the PWA's own browser window (PWA runs in Helium, a
   specific profile, on the Mac `bespin`).
4. (added) The inline view is **read-only**; replies stay on 🤖 Hand-to-Gary.
5. (added) Render in-text Slack mentions as **names**:
   `Hey U3B6KNK8B question` → `Hey @Chris B — question`.

## Grounding (verified on disk)

- Inbox UI: `frontend-overrides/js/inbox.js` (~792 lines). `openItem()` (~L608)
  does `window.open(url, '_blank')`; cards are render-only, no detail view.
- Sources: `backend/inbox/sources/{gmail,slack,asana,obsidian}.py`. **Calendar is
  not an inbox feed** — invites arrive as Gmail messages.
- Gmail full content already exists: `GET /api/email/read/{uid}` (HTML body).
- Slack feed = `bin/slack-refresh` writing `tmp/slack_recent_signals.json` with
  `unreads_raw` (firehose) + `mentions_raw` (`search @femanuele`). Parsed by
  `sources/slack.py`. Raw CSV text contains **bare `U…` IDs** (187 in the current
  snapshot) — confirms ask #5.
- slackmcp allowlist (`bin/slackmcp`, read-only): `conversations_history`,
  `conversations_replies`, `conversations_search_messages`, `conversations_unreads`,
  `conversations_mark`, `channels_list`, `users_search`, `usergroups_list`,
  `usergroups_me`.
- Users cache: `var/slack-users.cache.json` — 1,091 users, `id → real_name` /
  `profile.display_name`. Channels cache: `var/slack-channels.cache.json`.

## Decisions

- **Calendar:** render `.ics` invite details inside the inline email reader; no new source.
- **Inline view:** read-only. Replies via existing Hand-to-Gary.
- **Slack scope:** mentions + usergroups + replied-in threads. **Accept gap** (below).
- **Open behavior:** anchor-first; backend `open <url>` fallback (desktop-only).
- **Sequencing:** ship in slices, eyeball each on :8800.

## Known gaps (documented, not faked)

- **@here / @channel** can't be isolated: the CSV text is already de-tokenized
  (no `<!here>`/`<!channel>` markers — 0 found in current data), and Slack search
  has no `@here` operator. The only carrier is the unread firehose, which we're
  dropping. → Not delivered.
- **True subscribe/unsubscribe (followed/muted thread) state** is unreachable —
  no `subscriptions.thread` tool in the read-only allowlist. Best proxy =
  "threads I **replied** in that have **new** activity." → That proxy is what ships.

## Design — six changes, PoC-ordered

**Slice A (tiny, instant value)**
1. **Slack name resolution** — `sources/slack.py` loads `slack-users.cache.json`
   once (id → `@display_name`), replaces bare `U[A-Z0-9]{6,}` (and `<@U…>` if
   present) in title/snippet. Map reused by the inline thread view.
6. **Open behavior** — `inbox.js`: replace `window.open` with a real anchor click
   (`<a target=_blank rel=noopener>`); if that doesn't escape the PWA, add a small
   `POST /api/inbox/open {url}` that runs macOS `open <url>` (host/desktop only;
   guarded so phone access falls back to new-tab).

**Slice B (inline reader)**
2. **Slack open-in-place** — inline detail panel in `inbox.js` + new
   `GET /api/inbox/slack/thread?channel=&ts=` calling `conversations_replies`
   (names resolved). Tapping a card slides the reader open in place.
3. **Email + calendar open-in-place** — reader reuses `/api/email/read/{uid}`
   (HTML body); detect `text/calendar`/`.ics` and render When/Where/Organizer/
   attendees/RSVP read-only.
4. **Asana open-in-place** — inline task + comments via the existing PAT.

**Slice C (riskiest, last)**
5. **Slack filtering rework** — `bin/slack-refresh` + `sources/slack.py`: drop
   `unreads_raw` from the inbox merge; keep @mentions; add usergroup mentions
   (`usergroups_me` → handles → search each); add replied-in threads with new
   activity (`search from:@femanuele` → thread_ts → `conversations_replies`).
   Surface the @here/@channel + subscribe-state limits in the UI/source comments.

## Testing / verification

- Pure mappers (name resolution, ics parse, slack-row → item) get unit asserts
  like existing `scripts/test-*.mjs` / pytest mappers.
- Each slice live-verified on `http://bespin…:8800` before the next.
- Repo hygiene: **never `git add -A`** (concurrent sessions) — stage explicit
  paths; static JS/CSS needs no launchd restart, backend changes do (~25s+ cold).
