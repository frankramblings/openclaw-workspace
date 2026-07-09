# Branch salvage analysis — diverged feature branches

Scope: three unmerged branches that predate the redesign's live email/calendar
surfaces and have drifted far behind `main`. Decision is Frank's — this is the
2-minute version.

| Branch | Ahead / behind main | Recommendation |
|---|---|---|
| `calendar-rsvp` | 5 / 784 | **SALVAGE** (rebase-worthy, small conflict surface) |
| `v2-phase2a-email` | 7 / 776 | **CLOSE** (superseded by main) |
| `v2-phase2b-calendar` | 7 / 776 (same head as phase2a-email) | **CLOSE** (superseded by main) |

---

## `calendar-rsvp` — SALVAGE

**Commits** (`git log main..calendar-rsvp --stat`, oldest first):

1. `f142e1e` feat(calendar): parse incoming iCalendar REQUEST invites — new
   `backend/inbox/calendar_invite.py`, `extract_invite()` (RFC 5545 unfold/parse
   from raw email bytes).
2. `34185e5` feat(calendar): build iCalendar REPLY responses — same file,
   `build_reply()` / `reply_subject()`.
3. `d66ca2b` feat(email): heuristic invite-candidate flag on list rows —
   `is_invite_candidate()` in `backend/email_himalaya.py`, cheap subject/
   attachment sniff so the expensive .ics read is bounded.
4. `9921bdf` feat(email): RSVP orchestrator + `/api/email/rsvp` endpoint —
   `perform_rsvp()`: sends a MIME `REPLY`, marks the source email Seen, files
   it to Archive/Trash.
5. `a5b0f49` feat(email): expose parsed calendar block on read view.

All 5 commits touch only three files: `backend/email_himalaya.py`,
`backend/inbox/calendar_invite.py` (new), `backend/tests/test_calendar_invite.py`
(new).

**Overlap with what main/the redesign built since:** main's calendar RSVP path
(`backend/calendar_google.py: apply_rsvp/rsvp()`, wired through
`backend/inbox/sources/calendar.py` and the live `calendar.js` surface) is
**Google-Calendar-native only** — it flips `responseStatus` on an event that's
already synced to the calendar via the Calendar API. It does not touch email at
all. Main separately grew its own small, *display-only* `.ics` parser
(`backend/calendar_invite.py: parse_ics_calendar`, used by
`backend/tests/test_calendar_invite.py`) to show a calendar block on the email
read view — no reply-building, no RSVP action. So the branch's actual unique
value — **replying to an invite that arrived as an email `.ics` attachment**
(e.g. a non-Google invite, or one not yet synced to the calendar) — is *not*
superseded. It's a real capability gap.

**Rebase feasibility** — checked with a non-destructive
`git merge-tree $(git merge-base main calendar-rsvp) main calendar-rsvp`
(no working tree touched). Result: **3 small conflict regions, all mechanical**:

1. `backend/email_himalaya.py` — import line collides: main added
   `from .calendar_invite import parse_ics_calendar`, the branch adds
   `from .inbox import calendar_invite`. Different modules, different names —
   just keep both imports.
2. `backend/email_himalaya.py` — the `"calendar": ...` field in the read-view
   response dict: main builds it via `parse_ics_calendar(calendar_raw)`, the
   branch builds a similar dict via `calendar_invite.extract_invite(raw)`.
   Needs a decision on which parser wins for display (or keep main's for
   display and add the branch's `perform_rsvp`/endpoint as a separate action
   path — they don't have to share the parse call).
3. `backend/tests/test_calendar_invite.py` — **filename collision**: main
   added a test file at this exact path (79 lines, tests
   `backend.calendar_invite.parse_ics_calendar`); the branch adds a different
   161-line file at the same path (tests `backend.inbox.calendar_invite`).
   Trivial fix: rename the incoming one, e.g.
   `backend/tests/test_inbox_calendar_invite.py`.

No other files in the branch's 5 commits touched anything that changed on
main since the merge-base (`email_himalaya.py` only picked up 17
insertions/2 deletions upstream in the meantime) — the low behind-count on the
*touched files specifically* is why this is salvageable despite 784 commits of
overall drift.

**Recommendation:** rebase `calendar-rsvp` onto current `main`, resolve the 3
mechanical conflicts above, and land it as the email-side complement to the
existing Google-Calendar-native RSVP flow.

---

## `v2-phase2a-email` / `v2-phase2b-calendar` (same head `def7e74`) — CLOSE

**Commits** (`git log main..v2-phase2a-email --stat`, oldest first):

1. `eea34ab` feat(email): pure himalaya account-block renderers + default
   detection — `backend/email_config.py`.
2. `59431ed` feat(email): `add_account` writes 600 secret + merges himalaya
   config.
3. `9a714ce` harden(email): mode-600-from-create secret, reject duplicate
   account + blank password.
4. `987fbf0` feat(setup): `--add-email` configures a Gmail/IMAP himalaya
   account — `scripts/setup.sh`.
5. `b548231` fix(setup): `--add-email` requires a non-empty email address.
6. `0a3aa87` docs(email): document `setup.sh --add-email` + the secret model.
7. `def7e74` docs(plan): v2 Phase 2b — calendar CalDAV provider (976-line plan
   doc only, no implementation).

**Overlap with main:** this is not a partial overlap, it's a near-total
duplicate. `main` already has `backend/email_config.py` with **the same
function set** (`_render`, `render_gmail_account`, `render_imap_account`,
`has_default_account`, `_slug`, `add_account`) — main's version even adds a
`_shq()` shell-quoting helper and a belt-and-suspenders `os.chmod(0o600)` the
branch doesn't have. `main`'s `scripts/setup.sh` already ships `--add-email`
with essentially the same flag surface (`--email-provider`,
`--email-address`, `--email-name`, `--imap-host/-port`, `--smtp-host/-port`).
On top of that, `main` went further than the branch's plan doc ever got:
CalDAV is **implemented**, not just planned — `backend/calendar_caldav.py`,
`backend/calendar_config.py`, `backend/calendar.py`, `backend/ical.py`, plus
`setup.sh --add-calendar --calendar-provider caldav --caldav-url ...`.

**Rebase feasibility:** also checked with `git merge-tree` (non-destructive).
Result: **18 separate conflict regions** across `email_config.py` and
`setup.sh` — essentially every hunk collides because both sides independently
rewrote the same functions with different internal structure. This is the
signature of convergent reimplementation, not divergent unrelated work — there
is nothing left to reconcile.

**One nugget worth a manual look (not worth resurrecting the branch for):**
commit `9a714ce` rejects a duplicate `[accounts.<id>]` block before writing
(`if account_id in tomllib.loads(existing).get("accounts")`) — main's current
`add_account` dropped that specific guard. If duplicate-account safety matters,
it's a ~5-line manual patch to main, not a rebase.

**Recommendation:** close both branches. Nothing to salvage; the plan doc's
scope shipped independently and further.

---

## Disposition

- `calendar-rsvp`, `v2-phase2a-email`, `v2-phase2b-calendar`: left as-is (no
  branch deletion — unmerged, per hygiene rules). This doc is the record for
  Frank's close/rebase call.
