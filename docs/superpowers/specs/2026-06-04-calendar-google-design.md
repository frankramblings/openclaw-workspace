# Calendar tab → Google Calendar (reuse the google-calendar-mcp token) — design

**Date:** 2026-06-04
**Status:** approved (approach + full scope), pending spec review
**Scope:** Make the Odysseus Calendar tab a real Google Calendar client, reusing
the OAuth token the user already created for `google-calendar-mcp`. Second of the
calendar/email round; email is its own (completed) subsystem.

## Goal

A fully-functional calendar: list the user's 7 real calendars, view events in any
range, **create / move / delete** events, **quick-parse** natural language into an
event (via the OpenClaw brain), and **import ICS** — all on subscription pricing
(direct Google API with the existing OAuth, no new billing).

## Decisions (settled in brainstorming)

1. **Reuse the existing OAuth token directly via the Google Calendar REST API**
   from the Python backend — do NOT run the Node `google-calendar-mcp` as a
   middleman (it's just a shim over the same API). Verified live: refresh works,
   lists 7 real calendars.
2. **Token sourcing:** client keys from `~/.gmail-mcp/gcp-oauth.keys.json`
   (`installed`), refresh token from `~/.config/google-calendar-mcp/tokens.json`
   (the `normal` account → `refresh_token`, scope `…/auth/calendar`). The MCP's
   token file stays the source of truth; if the user re-auths via the MCP, the
   backend just picks up the new refresh token. Access tokens are refreshed
   on-demand and cached in memory (with expiry).
3. **Full scope in v1:** read (calendars + events), write (create/update/delete),
   quick-parse (brain), ICS import.
4. Backend adapter only — no frontend edits (same pattern as email/skills/cron).

## Architecture

### Components

- **`backend/google_auth.py`** — tiny OAuth helper: read client keys + refresh
  token, POST to Google's token endpoint, cache the access token until ~60s
  before `expires_in`. One job: hand out a valid bearer token. Reusable later
  for other Google APIs (Gmail, Drive).
- **`backend/calendar_google.py`** — the `/api/calendar/*` FastAPI router. Calls
  the Calendar REST API with `httpx` + the bearer token, maps Google ⇄ the
  iCal-ish shapes `calendar.js` expects, and routes quick-parse to the brain.
- **`backend/tests/test_calendar_google.py`** — pytest for the pure mappers
  (Google event ⇄ frontend event, calendar mapping, quick-parse prompt parsing).
- **`backend/app.py`** — include the calendar router.

### Auth flow

`google_auth.access_token()` → if cached + unexpired, return it; else POST
`grant_type=refresh_token` (client_id/secret + refresh_token) to
`https://oauth2.googleapis.com/token`, cache `access_token` + `now+expires_in`.
Read paths use it as `Authorization: Bearer`.

### Mapping (Google ⇄ frontend)

Frontend event shape: `{uid, summary, dtstart, dtend, all_day, location,
description, color, event_type, importance, calendar}`. Dates are **strings**:
`YYYY-MM-DD` when `all_day`, ISO datetime otherwise.

Google event → frontend:
- `uid` = event `id`; `summary`/`location`/`description` passthrough.
- `all_day` = bool(`start.date`); `dtstart` = `start.date` or `start.dateTime`;
  `dtend` = `end.date` or `end.dateTime`.
- `color` = the calendar's `backgroundColor` (per-event `colorId` is a fast-follow).
- `calendar` = the source calendarId.

Frontend create/update body → Google insert/patch:
- `summary/location/description` passthrough; `start`/`end` = `{date}` when
  `all_day` else `{dateTime, timeZone}`.

Calendar list → frontend: `{href: id, name: summary, color: backgroundColor,
hex: backgroundColor, primary}`.

## Endpoint contract (full scope)

| Endpoint | Google API |
|---|---|
| `GET /api/calendar/calendars` | `calendarList.list` → map |
| `GET /api/calendar/events?start&end` | for each enabled calendar `events.list` (timeMin/timeMax from start/end), merge → map |
| `POST /api/calendar/events` | `events.insert` (primary or body `calendar`) |
| `PUT /api/calendar/events/{uid}` | `events.patch` |
| `DELETE /api/calendar/events/{uid}` | `events.delete` |
| `POST /api/calendar/quick-parse` | brain bridge: `{text,tz}` → event JSON `{summary,dtstart,dtend,all_day,location}` |
| `POST /api/calendar/import` | parse ICS (stdlib/`icalendar` if needed) → `events.insert` each |
| `POST /api/calendar/sync` | no-op `{ok:true}` (we fetch live; no local cache to sync) |
| `POST /api/calendar/calendars/{id}` | calendar visibility/color toggle → store in a small `.data` overlay (Google's per-user calendar color is writable but keep v1 local) |

`start`/`end` query params + exact Google event JSON field formats are reconciled
against a live probe during implementation (Task 1 of the plan), the same way the
himalaya shapes were.

## Multi-calendar event fetch

`events` aggregates across calendars. v1: fetch the user's selected/enabled
calendars (default: all non-hidden). Each `events.list` call is one HTTP request;
run them concurrently (`asyncio.gather`) within the start/end window, tag each
event with its `calendar`/`color`, merge. Cap per-calendar results (e.g. 2500).

## quick-parse (brain)

`{text, tz}` → prompt the OpenClaw brain (same `_brain_once` bridge as email
AI-reply) to return STRICT JSON `{summary, dtstart, dtend, all_day, location}`
for the described event; parse it, return to the UI (which then POSTs create).
Degrade gracefully (clear error) when the brain is stalled — exactly like
email AI-reply.

## Error handling

- Token refresh failure → 502 with a setup hint (re-auth the calendar MCP).
- Google API non-2xx → surface status + message into the UI's existing
  `data.error` / toast handling (frontend already checks `r.ok`).
- Writes are optimistic in the UI; return the created event's real `uid` so the
  optimistic temp id is reconciled.

## Testing

- **Read** verified live: list 7 calendars, fetch events in the current week.
- **Write** tested by creating a clearly-marked **`[workspace test]`** event on
  the primary calendar, verifying it lists, then **deleting it** (cleanup) — no
  lasting changes to the real calendar.
- **quick-parse** verified once the brain is healthy ("lunch with Sam Tuesday
  1pm" → structured event).
- **ICS import** tested with a tiny hand-written `.ics` (one event), then delete.
- pytest on the pure mappers.

## Out of scope (v1)

- Per-event `colorId` (use calendar color); recurring-event editing nuances
  (single-instance vs series); attendees/invites; push/webhook sync (we fetch
  live); writing Google's per-user calendar color (kept local).

## Frontend contract reference (must satisfy; do not edit frontend)

- `GET /api/calendar/calendars` → `{calendars:[{href,name,color,hex,primary}]}`
- `GET /api/calendar/events?start&end` → `{events:[{uid,summary,dtstart,dtend,
  all_day,location,description,color,calendar}]}`
- `POST /api/calendar/events` (create) / `PUT …/{uid}` (update) body = event
  fields incl. `dtstart,dtend,all_day,summary,location,description,calendar?`;
  response `{uid, …}`.
- `DELETE /api/calendar/events/{uid}` → `{ok:true}` (or `{deleted:[uid]}`).
- `POST /api/calendar/quick-parse` body `{text,tz}` → `{summary,dtstart,dtend,
  all_day,location}` (or `{error}`).
- `POST /api/calendar/import` (ICS) → `{ok,imported}`; `POST /api/calendar/sync`
  → `{ok:true}`.
