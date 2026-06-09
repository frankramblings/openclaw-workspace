# v2 Phase 2 — Generalized integrations

**Date:** 2026-06-09
**Status:** Design approved; ready for per-integration plans (build order: email → calendar → inbox).
**Builds on:** Phase 1 (`docs/superpowers/specs/2026-06-08-v2-installable-on-any-openclaw-design.md`) — `connection.json.integrations` enable flags, `/api/capabilities`, the doctor.

## Goal

Phase 1 made the workspace *connect* to any OpenClaw. Phase 2 makes its
**account-specific tabs work for a new user**, not just the maintainer. Today
email is tied to the maintainer's Gmail app-password, calendar reuses the
maintainer's `google-calendar-mcp` OAuth tokens, and the inbox runs four
hardcoded collectors every request. After Phase 2 a new user explicitly
configures only the integrations they have, each works on their own accounts,
and the rest stay cleanly disabled.

## Non-goals

- No new product surfaces — same tabs, made configurable.
- **Email:** app-password / IMAP only. Gmail/OAuth device-flow is out of scope.
- **Calendar:** CalDAV is the new universal provider; the existing Google REST
  path is kept working but not expanded (no per-user GCP automation).
- No multi-account-per-integration (one account per integration is enough).

## The spine (shared across all three)

A consistent model so the three integrations look and behave alike:

1. **Enable flag** — `connection.json.integrations.<name>` (from Phase 1) is the
   on/off switch. Phase 2 makes the backends *respect* it (the inbox especially).
2. **Per-integration config** — non-secret settings live in a small gitignored
   file under `.data/` (e.g. `.data/calendar.json`, `.data/inbox.json`); email
   reuses himalaya's own `config.toml`. **Secrets never go in these JSON files** —
   they live in mode-600 secret files (the himalaya pattern) or env, mirroring
   Phase 1's password discipline (a copied `.data/` must not leak a credential…
   except `.data/secrets/` which is the deliberate local secret store, 600).
3. **Configure path** — `scripts/setup.sh` gains a consistent way to set each one
   up and flip its enable flag.
4. **Capability** — `/api/capabilities` (Phase 1) already gates each tab on
   tool/config presence + enabled; Phase 2 fills in the real checks.
5. **Tests** — each integration ships gateway-free pure-logic tests.

`.data/secrets/` (new) is gitignored (under the existing `/.data/` rule), created
mode 700, files mode 600.

---

## 2a · Email (build first — smallest)

**Current state:** `email_himalaya.py` is already account-agnostic — `_account_address()`
/ `_account_name()` read the **default** account from `~/.config/himalaya/config.toml`.
The only gap: a new user has no himalaya config.

**Design:**
- `scripts/setup.sh --add-email` (interactive; flags for non-interactive):
  - Prompt provider: **Gmail (app-password)** or **generic IMAP/SMTP**.
  - Gmail: prompt address + app-password → write a himalaya `config.toml` account
    block (IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:465`, the Sent/Drafts
    folder mapping the maintainer's working config uses, `message.send.save-copy=false`)
    and the password in a mode-600 secret file read via himalaya's `auth.cmd`
    (matching the maintainer's `tr -d ' \n' < …` pattern).
  - IMAP: prompt host/port/user + app-password/password for IMAP and SMTP.
  - If a `config.toml` already exists, write the new account as an additional
    block and only set `default=true` when there's no existing default (never
    silently steal default from an existing account).
  - Set `integrations.email=true`.
- A pure helper `email_config.render_himalaya_account(provider, **fields) -> str`
  (TOML text) so the generation is unit-testable without writing files.
- Verify the email backend reads the configured/default account end-to-end with a
  non-maintainer account name (no hardcoded account label).

**Tests:** `render_himalaya_account` for Gmail + IMAP (correct TOML, secret via
auth.cmd, save-copy false); default-account-not-stolen logic.

**Capability:** already implemented (himalaya binary + config present + enabled).

---

## 2b · Calendar (build second — one new backend)

**Current state:** `calendar_google.py` (router) + `google_auth.py` talk to the
Google Calendar REST API using OAuth tokens at env-overridable paths
(`GOOGLE_OAUTH_KEYS`, `GOOGLE_CAL_TOKENS`). Works for the maintainer; a new user
has no tokens and creating a GCP project is high-friction.

**Design — make the calendar tab provider-pluggable, add CalDAV:**
- **Config** `.data/calendar.json`: `{ "provider": "google" | "caldav",
  "caldav": { "url": "...", "username": "..." } }`. CalDAV password in
  `.data/secrets/caldav-password` (600) or env `CALDAV_PASSWORD`. Default provider
  when the file is absent: `google` (preserves the maintainer's current behavior).
- **`backend/calendar_caldav.py`** — a CalDAV client over `httpx` (no new heavy
  dep): `PROPFIND` to discover calendars, `REPORT` (calendar-query) to list events
  in a date range, `PUT`/`DELETE` of `.ics` for create/update/delete. Parse/emit
  iCalendar with a small dependency-free VEVENT (de)serializer (the workspace
  already avoids PyYAML; same spirit). Maps to the SAME frontend shape the Google
  backend returns (calendars with id/name/href; events with id/title/start/end/…).
  Works with Google (CalDAV + app-password), iCloud, Fastmail, Nextcloud.
- **`backend/calendar.py` selector** — `backend(provider) -> module` returning the
  google or caldav implementation behind a common interface
  (`list_calendars`, `list_events(start,end)`, `create_event`, `update_event`,
  `delete_event`, `quick_add`). The existing `calendar_google.py` is refactored to
  expose these as plain functions; its router moves to `calendar.py` and dispatches
  to the selected backend. Endpoints and the frontend are unchanged.
- `scripts/setup.sh --add-calendar`: prompt provider; for CalDAV prompt URL +
  username + password (→ secret file); write `.data/calendar.json`; set
  `integrations.calendar=true`.

**Tests:** the iCal VEVENT (de)serializer round-trip; CalDAV response parsing
(PROPFIND/REPORT XML → calendar/event dicts) against captured fixture XML; the
provider selector picks google/caldav from config. No live network in tests.

**Capability:** extend Phase 1's `_calendar()` to also report available when
provider=caldav and a CalDAV URL+credential are configured (not only the Google
token files).

**Risk note:** this is the largest single piece of Phase 2 (a new protocol
client). If it grows, the iCal serializer and the CalDAV client are independently
testable units and can be split across two plan-stages.

---

## 2c · Inbox (build last — biggest surface)

**Current state:** `inbox/__init__.py` has a hardcoded `SOURCES` dict
(gmail/slack/asana/obsidian/documents_stale) and `items()` runs **all** of them
every request; a missing account just lands in the per-source `errors{}` (noisy,
wasteful). Each source reads its own settings from env defaults.

**Design — config-driven collectors:**
- **Config** `.data/inbox.json`:
  ```json
  {
    "collectors": {
      "gmail":    { "enabled": false, "internal_domain": "example.com" },
      "slack":    { "enabled": false, "domain": "example.slack.com" },
      "asana":    { "enabled": false, "project_gid": "", "pat_path": "~/.openclaw/workspace/secrets/asana.env" },
      "obsidian": { "enabled": false, "vault": "~/.openclaw/workspace/Meetings", "window_days": 120 }
    }
  }
  ```
  `documents_stale` is workspace-native (no external account) → always on when the
  inbox is enabled. Secrets (Asana PAT) stay in their own file, referenced by path.
- **`backend/inbox/settings.py`** (new) — `inbox_config() -> dict` reads/caches
  `.data/inbox.json` (returns the documented default with everything disabled when
  absent). Each source reads its settings through small accessors there
  (`gmail_internal_domain()`, `obsidian_vault()`, etc.) with the precedence
  **env > inbox.json > default** (env override retained for back-compat). The
  existing module-level constants in each source (e.g. `INTERNAL_DOMAIN`) become
  thin calls to these accessors.
- **`inbox/__init__.py`** — `items()` runs only collectors whose
  `enabled` is true (plus the account-free `documents_stale`); a disabled or
  unconfigured collector is simply not run (no more noisy `errors{}` for accounts
  you don't have).
- **Capability:** inbox available iff `integrations.inbox` is on AND ≥1 collector
  enabled (refine Phase 1's `_inbox()`).
- `scripts/setup.sh --enable inbox` plus a documented way to edit `.data/inbox.json`
  (interactive per-collector prompts are optional; the documented file + flags are
  the contract).

**Tests:** collector-selection (only enabled run), config→settings wiring per
collector, capability reflects ≥1-enabled.

**Migration for the maintainer:** seed `.data/inbox.json` with the maintainer's
current collectors enabled (gmail/slack/asana/obsidian) + their real values so the
live inbox is unchanged. (Lives in gitignored `.data/`, like the Phase-1 branding
seed.)

---

## Build order & deliverables

1. **Email** plan → build → merge.
2. **Calendar** plan → build → merge.
3. **Inbox** plan → build → merge.

Each is its own implementation plan (per the multi-subsystem rule) and its own
worktree/review/merge cycle. Backwards-compat invariant (as in Phase 1): the
maintainer's live install behaves identically — email reads the existing
config.toml, calendar defaults to the Google provider with the existing tokens,
inbox is seeded with the current collectors.

## Cross-cutting

- **Docs:** README "Connecting to your OpenClaw" gains an "Optional integrations"
  subsection (how to add email/calendar/inbox); `.env.example` notes the new
  config files; ARCHITECTURE notes the per-integration config + provider-pluggable
  calendar.
- **Testing:** gateway- and network-free pure-logic tests next to each module; CI
  unchanged (it already runs `--skip-connect`).
- **Secrets:** `.data/secrets/` (700) for CalDAV password etc.; never in JSON,
  never committed.

## Risks / open questions

- **CalDAV variance** across providers (Google vs iCloud quirks in PROPFIND depth,
  href shapes, timezone handling). Mitigation: code against the CalDAV RFC4791
  basics, test with captured fixtures, document "tested against Google/Fastmail";
  surface clear errors rather than silently mis-parsing.
- **iCal timezones / recurring events** — Phase 2 CalDAV targets single + all-day
  events and reads recurring instances as the server expands them (calendar-query
  with a time-range REPORT returns expanded instances on most servers); full RRULE
  authoring is out of scope for v2.
- **Inbox config migration** must be seeded for the maintainer before the
  enabled-only change lands, or their feed goes empty after deploy.
