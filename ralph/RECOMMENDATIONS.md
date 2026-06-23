# Recommendations — make every no-op do what the user expects

Goal (Frank's ask): every dead/no-op affordance in the redesign should perform the action a user would expect.

**Key finding that reframes everything:** almost every dead button **already has a working backend endpoint** — the redesign simply never added the front-end `actions[…]` handler. So most of these are *small wiring jobs* (add a handler that calls an existing endpoint + attach a `data-act`), **not** the "feature builds" the FINDINGS deferrals implied. Endpoints below were verified against `backend/app.py` route decorators and the legacy `frontend/js/*.js` callers.

**Conventions to follow** (copy the two already-correct live modules):
- Optimistic update → `apiJson(path, body, method)` → `runtime.render()` → `reload('<surface>')`. Template: `live/inbox.js:92` (`dismiss`) and `live/calendar.js:310` (`clearQuick`).
- Helpers already exist in `live/api.js`: `apiGet`, `apiJson(path, body, method='POST')`, `apiForm`, `apiDelete(path)`.
- All edits go in `frontend-overrides/`; then run `bash scripts/sync-frontend.sh`.
- Destructive actions (delete/wipe) must get a confirm guard before the call.

Priority order = quickest-win / highest-impact first.

---

## P0 — Orphaned `data-act` and a silent data-loss bug (cheapest; pure front-end)

These render a control that dispatches to a handler that doesn't exist (or the wrong one). Endpoints already exist.

| Affordance | Expected action | Wire it |
|---|---|---|
| **"Discuss" chip** on a past research run — `surfaces.js:330` `data-act="resDiscuss"` (no handler) | Open a chat seeded from that research run | Add `resDiscuss(rid)` to `live/research.js` actions → `POST /api/research/spinoff/{rid}` (returns/creates a session) → switch to chat + `selectSession(newId)`. |
| **"↗ Visual Report" chip** — `surfaces.js:330` `data-act="resReport"` (no handler) | Open/generate the visual report for that run | Add `resReport(rid)` → `GET /api/research/report/{rid}` (exists) → open it (Library surface or new tab). |
| **Mobile "Send to Gary"** quick-capture — `mobile-sheets.js:66` is wired to `closeCapture`, so **the typed capture is silently discarded** | Submit the capture, then close | Add `sendCapture()` to `mobile-app.js`: branch on `state.captureType` → remind → `POST /api/notes` (or reminder create); note → `POST /api/notes`; task → task create. POST `state.captureDraft`, clear, `closeCapture()`. Re-point the button's `data-act` from `closeCapture` → `sendCapture`. |

---

## P1 — Auth & destructive (HIGH priority; users are blocked or data is at risk)

All endpoints confirmed from the legacy callers.

| Affordance | Expected action | Wire it |
|---|---|---|
| **Logout** — Account card, `set-btn` (settings-data.js:122), no `data-act` | Sign the user out | `actions.logout` → `POST /api/auth/logout` (legacy settings.js:2070) → redirect to `/` / reload. |
| **Update Password** — Change Password card, `set-btn` (settings-data.js:123) | Change password | Bind the 3 `inp()` fields to `data-model` (current/new/confirm), `actions.changePassword` → validate match → `POST /api/auth/change-password` (legacy settings.js:1948). Show success/error. |
| **Add User** — Users section, `set-btn` (settings-data.js:140) | Create an admin/user | Bind username/password + admin toggle, `actions.addUser` → `POST /api/auth/users {username,password,is_admin}` (legacy admin.js:289). |
| **Wipe all {memory,skills,chats,notes,tasks,documents,gallery,calendar}** — 8 Danger-Zone `set-btn danger` (settings-data.js:144–152) | Wipe that data category | `actions.wipe(kind)` → **confirm dialog first** → `POST /api/admin/wipe/{kind}` (legacy `/api/admin/wipe/{kind}`) → `reload`. Pass the category as `data-arg`. |

---

## P2 — Core chat composer (high-traffic, user-facing)

| Affordance | Expected action | Wire it |
|---|---|---|
| **Model picker** — `.model-btn` "Switch model" (surfaces.js:98), no `data-act` | Choose the chat model | `GET /api/models` (exists) for the list → render a dropdown/sheet → `actions.setModel(id)` sets `state … model` and is sent on next `send()` (the stream POST already accepts model context). Persist per-session if desired. |
| **Reasoning-effort pill** — `.pill-btn` "Reasoning effort" (surfaces.js:97), no `data-act` | Pick reasoning effort | `actions.setEffort(level)` → store in state → include in the `/api/chat/stream` body alongside `mode`. |
| **Attach Files** (`cb-attach` advertised; no composer button) | Attach a file to the next message | Add a paperclip `<input type=file>` → `POST /api/upload` (exists) → keep the returned id in state → include on next `send()`. Also un-hide via the Chat Bar toggle. |

---

## P3 — Per-surface action buttons (all have endpoints; add handlers + `data-act`)

**Email** (`live/email.js` currently only has `selEmail`/`mOpenReader`):
- "+ New" compose (surfaces.js:122) → composer → `POST /api/email/send` (or `/api/email/draft` to save).
- "Reply"/"Reply all"/"Forward" (:147–149) → prefilled composer → `POST /api/email/send`.
- "✦ AI reply" (:151) → `POST /api/email/ai-reply` → load draft into composer.
- "✦ Summarize" (:152) → `POST /api/email/summarize` → show summary.
- Archive (reader/list) → `POST /api/email/archive/{uid}`.
- Writing-Style "Extract from Sent" (index 2130) → `POST /api/email/extract-style`; "Save" (2131) → `POST /api/email/style`.

**Calendar:**
- "+ New" event (surfaces.js:255) → event form → `POST /api/calendar/events` (already used by `clearQuick`).
- "Today" (:250) → client-side: jump the view to today (no backend).

**Notes:**
- "+ New" note (surfaces.js:380) → `POST /api/notes` → select it. (`live/notes.js` already lists; add the create action.)

**Library / Documents:**
- "New document" (legacy library-new-doc-btn) → `POST /api/document` → open in editor. Library list = `GET /api/documents/library` (already loaded).

**Research:**
- "+ Queue" (surfaces.js:306) → enqueue a research run via `POST /api/research/start`.
- Report row actions ("↗ Visual Report"/"Discuss"/"Save to Library") → see P0 (`/api/research/report/{rid}`, `/api/research/spinoff/{rid}`).

---

## P4 — Conversation & session management (endpoints exist; currently absent)

| Affordance | Expected action | Wire it |
|---|---|---|
| **Delete conversation** (no affordance today) | Delete the session | Add a per-row delete (hover btn / mobile swipe) → confirm → `DELETE /api/session/{session_id}` (exists) → refresh `GET /api/sessions`. |
| **Archive conversation** | Archive/unarchive | `POST /api/session/{id}/archive` · `/unarchive` · `/restore` · `/important` (all exist). |
| **Conversation "More" menu** — chat header has only title/subtitle (surfaces.js:78) | Rename / Copy / Export PDF+doc | Add a kebab menu: Rename → (session rename endpoint / `/api/session/{id}`); Copy → serialize thread to clipboard; Export → `GET /api/document/{doc_id}/export` or transcript export. |
| Bulk archive/delete/sort (legacy sidebar toolbar) | Multi-select management | Optional "manage mode" using the same per-session endpoints; sort is client-side over the loaded list. |

---

## P5 — Workspace file management (every button maps to an endpoint)

`companion.js` Files tab is browse-only. Add a toolbar wired to:
- New file → `POST /api/workspace/create`
- New folder → `POST /api/workspace/mkdir`
- Upload → `POST /api/workspace/upload`
- Refresh → re-`GET /api/workspace/tree`
- (Also available: `/api/workspace/rename`, `/move`, `/delete`, `/archive` for context actions.)

---

## P6 — Settings data controls (existing endpoints; make the cards live)

- **Export Data** → `GET /api/export` (legacy). **Import Data** → corresponding import (confirm the route; memory has `/api/memory/import`).
- **Model endpoints** ("Added Models" read-only; adm-ep* buttons) → `GET/POST /api/model-endpoints` to list/add; test via the same. Provider/select rows: convert `select`/`provider` display spans into real controls writing to `/api/auth/settings`.
- **Fallbacks "+ add"** (`set-add`, surfaces.js:439) → edit the fallback list → persist via `/api/auth/settings`.
- **Search provider + "Test"** (search panel) → save to `/api/auth/settings`; Test → provider test endpoint.
- **Brain / Skills** content (relocated from the memory-modal) → `GET /api/memory`, `/api/memory/add`, `/api/memory/audit`, `/api/memory/{mid}/pin`; `GET /api/skills`, `/api/skills/add`, `/api/skills/audit-all`.
- **Scheduled jobs** → `GET /api/cron`, `/api/cron/{job}/run|enable|disable|runs` (this is the real target for the dead "Open Scheduled jobs" launcher).

---

## P7 — Search (decorative everywhere)

Convert each static `<div class="oc-search">` to a real input:
- **Conversations / Library / Notes filters** (surfaces.js:23/343/381) → cheapest: an `<input data-model="…Filter">` + client-side filter of the already-loaded list (same pattern as `libFilter`). No backend needed.
- **Inbox search** (:123) → client filter, or `/api/items` query.
- **Email search** → `GET /api/email/search` (exists).
- **Global ⌘K** → add a single global `keydown` handler in `app.js` that focuses the active surface's filter (or opens a command palette). This also unblocks the other advertised shortcuts.

---

## P8 — The dead "launcher" buttons need a destination

`set-launcher` "Open Brain" / "Open Scheduled jobs" / "Open theme picker" (surfaces.js:479) have **no target surface**. Two options each:
- **Open Brain** → either build a Brain surface over `/api/memory` + `/api/skills`, OR repurpose the launcher to `setSection('brain')` and make the Brain card itself interactive (P6).
- **Open Scheduled jobs** → `setSection('scheduled')` + wire the cron endpoints (P6).
- **Open theme picker** → either drop it (inline accent already works via `setAccent`) or build the fuller picker.

---

## P9 — Cleanups & decisions (not all need wiring)

- **Trim the advertised-but-nonexistent toggles.** Settings → Sidebar lists Compare/Cookbook/Gallery/Tasks (+ Brain/Search/Tools/Theme/User) and Chat Bar lists web/doc/shell/attach/chars — many point at controls/surfaces that don't exist. Either build them or remove from the lists so the toggles aren't lying.
- **Missing surfaces** (Compare / Cookbook / Gallery / Tasks): decide build-vs-drop. Gallery data still exists server-side (there's a wipe for it); Tasks has cron/`/api/email/scheduled`.
- **Incognito / Nobody mode**: reimplement (UI + state + server flag) or remove the `ca-incognito` toggle + ⌘⇧I shortcut card.
- **(Minor) Scroll-to-bottom** jump button in chat — pure client UX, nice-to-have.

---

### Bottom line
The redesign is a **UI shell that was never connected**, not a half-built backend. The backend (`backend/app.py`) already exposes endpoints for sessions, email, calendar, notes, documents, research, memory, skills, cron, workspace files, uploads, auth (logout/change-password/users), and admin wipe. The work is overwhelmingly: *add the `actions[…]` handler that calls the endpoint that already exists, and attach the `data-act`.* Start at P0/P1 (cheap + high-impact), reusing the `dismiss`/`clearQuick` optimistic pattern.
