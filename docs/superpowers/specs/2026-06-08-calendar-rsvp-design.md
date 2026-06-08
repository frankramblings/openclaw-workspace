# Calendar-invite RSVP in Inbox + Email tab — Design

**Date:** 2026-06-08
**Status:** Approved (brainstorming)
**Scope:** Gmail-only. Slack/Asana/obsidian/documents sources untouched.

## Goal

Emails that are calendar invitations expose **Yes / Maybe / No** RSVP controls on
both the **Inbox card** and the **Email tab read view**. Each RSVP action:

1. Sends an iCalendar `METHOD:REPLY` to the organizer (provider-agnostic; Gmail /
   Google Calendar process it and update RSVP state — no Calendar API needed).
2. Marks the source email read (`flag add Seen`).
3. Moves the email out of INBOX:
   - **Yes / Maybe** → `[Gmail]/All Mail` (archive, `email_himalaya.ARCHIVE_FOLDER`).
   - **No** → `[Gmail]/Trash` (`email_himalaya.TRASH_FOLDER`).
4. Dismisses the inbox card (`state.dismiss(reason="rsvp:<status>")`).

RSVP mapping: `yes→ACCEPTED`, `maybe→TENTATIVE`, `no→DECLINED`.

## Constraints (host)

The host is a 2014 Mac mini (8GB) where every himalaya read is a slow subprocess
(`[[project_hardware_constraint]]`). Detection MUST NOT read every inbox email's
body on each refresh.

## Architecture

### 1. New module: `backend/inbox/calendar_invite.py`

Pure functions, no I/O, so they're unit-testable:

- `extract_invite(raw: bytes) -> dict | None`
  Parse a raw RFC-822 message with the stdlib `email` parser; walk parts for a
  `text/calendar` part whose `METHOD` is `REQUEST`. Parse the embedded `VEVENT`
  (line-unfolding per RFC 5545 — join continuation lines starting with a space/
  tab before splitting on the first `:`). Return:
  `{uid, sequence, summary, start, end, location, organizer, dtstamp,
    recurrence_id?}` or `None` if no REQUEST invite is present.
  `start`/`end` are kept as the raw iCal `DTSTART`/`DTEND` values (with their
  `TZID`/`VALUE` params preserved as-is) plus a best-effort ISO string for the UI.

- `build_reply(invite: dict, attendee_addr: str, partstat: str) -> str`
  Emit a `VCALENDAR` text with `METHOD:REPLY`, `PRODID`, one `VEVENT` carrying
  the original `UID`, `SEQUENCE`, `ORGANIZER`, `DTSTART`/`DTEND` (copied verbatim),
  `RECURRENCE-ID` if present, a fresh `DTSTAMP` (passed in — `Date.now()` is
  unavailable in this codebase's test harness, but the backend can use
  `datetime.now(timezone.utc)`), and one `ATTENDEE`:
  `ATTENDEE;PARTSTAT=<ACCEPTED|TENTATIVE|DECLINED>;CN=<addr>:mailto:<addr>`.
  `partstat` validated against the three allowed values.

- `reply_subject(status: str, summary: str) -> str`
  `"Accepted: <summary>"` / `"Tentative: <summary>"` / `"Declined: <summary>"`.

### 2. `backend/email_himalaya.py`

- Extend `build_mime` (or add `build_calendar_reply_mime`) to attach the reply as
  a `text/calendar; method=REPLY; charset=UTF-8` part alongside a one-line
  `text/plain` body (`"<addr> has accepted/tentatively accepted/declined ..."`).
  Use `EmailMessage.add_alternative(ics, subtype="calendar", params=...)`.
- `message_to_read` gains a `calendar` key: when `extract_invite` finds a REQUEST
  invite in the already-parsed message, attach the parsed invite dict so the
  Email read view can render RSVP buttons. (No extra read — the raw bytes are
  already in hand.)

### 3. Backend endpoints

- **Inbox** — new `rsvp` branch in `POST /api/items/action`
  (`backend/inbox/__init__.py`), gmail-only:
  payload `{source:"gmail", id, action:"rsvp", rsvp:"accepted|tentative|declined",
  meta:{uid, from, calendar:{organizer,...}}}`.
  Orchestration (shared helper, see §4):
  read the .ics → `build_reply` → send via himalaya SMTP → `flag add Seen` →
  `move_message(INBOX → archive|trash)` → `state.dismiss`.
  `undo`: `{folder: <archive|trash>, from, note: "reply email already sent — only the email is restored"}`
  so the existing archive/delete undo path (`find_uid` + `move_message` back to
  INBOX) restores the card. The sent reply cannot be unsent — surfaced in the note.

- **Email tab** — new `POST /api/email/rsvp/{uid}`
  body `{rsvp:"accepted|tentative|declined", folder:"INBOX"}`.
  Same orchestration via the shared helper. Returns `{ok, status, moved_to}`.

### 4. Shared orchestration helper

`calendar_invite.perform_rsvp(uid, folder, status) -> dict` in
`backend/email_himalaya.py` (it needs himalaya + the `_from_header()` address):

1. `raw = message export uid -F -f folder`.
2. `invite = extract_invite(raw)`; if `None` → raise (caller → 4xx "not an invite").
3. `mime = build_calendar_reply_mime(invite, _from_header_addr(), status)`.
4. `message send` stdin=mime (reuse `_himalaya_with_retry` — mailbox writes are
   flaky on this host).
5. `flag add Seen`.
6. `move_message(uid, folder, archive if status!="declined" else trash)`.
7. return `{status, moved_to}`.

Both endpoints call this; the inbox endpoint additionally does the
`state.dismiss` + history-log bookkeeping.

### 5. Detection in `backend/inbox/sources/gmail.py`

- `map_items`: cheap candidate flag from the envelope only — set
  `meta.maybeInvite = True` when `has_attachment` is true **and** the subject
  matches an invite pattern (`re` on `^(Invitation|Updated invitation|Accepted|
  Declined|Tentative|Canceled event):`) **or** the sender is a known calendar
  address. No body read here.
- `fetch`: after `map_items`, for candidates only, lazily
  `email_read(uid, mark_seen=False)` → `extract_invite`. Confirmed invites get
  `meta.calendar = {summary,start,end,location,organizer,startISO}`, drop the
  archive/delete chips in favor of `actions: ["rsvp", "snooze", "dismiss"]`, and
  bump score slightly. Cap the number of confirm-reads per refresh (e.g. 8) and
  `log`-style note any skipped — the 60s `_cache` makes the cost one-per-window.

### 6. Frontend

- `frontend-overrides/js/inbox.js`: when `item.meta.calendar` is set, render the
  event time + location line and three RSVP chips (reuse existing `✨`/rec chip
  styling + the swipe-primary path: right-swipe = Yes). Click → `POST
  /api/items/action {action:"rsvp", rsvp}` → existing dismiss/undo-toast flow.
- Email tab (`frontend-vendor/js/emailInbox.js`): the Email tab has **no
  read pane** — clicking a row opens a reply/compose doc, so there's no "body"
  to sit buttons above. Instead, the per-row actions menu (`_showEmailMenu`,
  alongside Open/Archive/Delete) gains **RSVP: Yes / Maybe / No** items, shown
  only when the row is `is_invite_candidate` (the cheap envelope heuristic, set
  in `envelope_to_email`). Click → `POST /api/email/rsvp/{uid}` → on success
  drop the row from the list with a toast. The backend confirms the invite
  (read + `extract_invite`) inside `perform_rsvp`; a candidate that isn't a real
  invite returns a 400 surfaced as an error toast. `message_to_read` still
  exposes a `calendar` block (usable by any future read view), but the row menu
  is the live surface.

## Testing

- Unit (node-free, pytest): `extract_invite` on real Google + Outlook invite
  fixtures (REQUEST, with/without DTEND, with TZID, recurring with
  RECURRENCE-ID), and on a non-invite (returns `None`). `build_reply` golden
  output asserts `METHOD:REPLY`, correct `PARTSTAT`, preserved `UID`/`SEQUENCE`/
  `ORGANIZER`, line-folding ≤75 octets.
- Live smoke (manual, this host): send a real invite to the account, RSVP Yes
  from the inbox card → confirm reply lands in organizer's calendar + email
  archived + marked read; RSVP No from the Email tab → confirm trashed.

## Out of scope (YAGNI)

- Per-occurrence RSVP UI for recurring events (master UID reply only;
  RECURRENCE-ID passed through but no instance picker).
- Proposing a new time / `COUNTER`.
- Adding the invite to a local calendar / any Calendar API integration.
- Non-gmail sources.

## Repo hygiene

Concurrent-session risk in this repo: never `git add -A`; stage explicit paths
(`[[project_openclaw_workspace_inbox]]`). Static JS/CSS need no launchd restart;
backend Python changes do need a gateway restart (mind the slow cold boot,
`[[project_hardware_constraint]]`).
