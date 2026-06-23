# Implementation log — wiring no-ops to real endpoints (P0→P9)

Tracks the build-out from `RECOMMENDATIONS.md`. Each entry: what was wired + the endpoint + files. All edits in `frontend-overrides/`, deployed via `scripts/sync-frontend.sh`.

## P0 — orphaned data-act + data-loss bug — ✅ DONE
- **resDiscuss(rid)** — `live/research.js`. Past-research "Discuss" chip → `POST /api/research/spinoff/{rid}` → navigates to chat + `runtime.actions.selectSession(newId)` (loads the spun-off session's thread). Falls back to `go('chat')` if no id.
- **resReport(rid)** — `live/research.js`. "↗ Visual Report" chip → opens `/api/research/report/{rid}` in a new tab.
- **sendCapture()** — `mobile/mobile-app.js` + re-pointed the "Send to Gary" button in `mobile-sheets.js` from `closeCapture`→`sendCapture`. Persists `captureDraft` as a note `POST /api/notes {title, body, kind=remind|note|task}`; optimistic close, restores the text on failure so a capture is never lost. (Was: silently discarded.)
- Verified: `node --check` on all 3 files passes; `runtime.actions` already exposed (app.js:263); `mobileActions` merged (app.js:185); research actions merge via `loadSurface('research')`. Synced to `frontend/`.

## P1 — auth/destructive — partial (Logout + Wipe done; Password/AddUser next)
- **Settings dispatch mechanism** (unlocks P1+P6): `surfaces.js` `buttons` case now emits `data-act`/`data-arg` when a button object has `act`/`arg`; `danger` case emits `data-act="wipe" data-arg="${kind}"`. `settings-data.js` `danger()` helper gained a `kind` param.
- **Logout** — `settings-data.js:122` Logout button → `act:'logout'`; handler `live/settings.js` → `POST /api/auth/logout` → redirect to `/`. (User can now sign out.)
- **Wipe all {kind}** — the 8 Danger-Zone rows now carry their kind (chats/memory/skills/notes/tasks/documents/gallery/calendar); handler `wipe(kind)` in `live/settings.js` → `window.confirm` guard → `DELETE /api/admin/wipe/{kind}`. Methods/kinds confirmed from legacy admin.js.
- Verified: node --check all 3 files; synced; built output carries the data-act + handlers.
- TODO next: **Update Password** (`POST /api/auth/change-password`) and **Add User** (`POST /api/auth/users`) — need the `inp()` fields bound to `data-model` first.

## P1 — auth/destructive — ✅ DONE (Password + AddUser added)
- **Bound text inputs**: `inp()` gained `model`/`itype`; the `input` renderer now emits a real `<input type=… data-model=… data-focus=…>` (controlled via app.js:211 + focus-restore) when a `model` is set — otherwise the old display div.
- **Update Password** — Change Password card fields bound to `pwCurrent/pwNew/pwConfirm` (type=password); button `act:'changePassword'` → `live/settings.js` validates (≥8, match) → `POST /api/auth/change-password {current_password, new_password}` (body matches legacy) → clears fields.
- **Add User** — Username/Password bound (`newUsername/newPassword`); admin from the `newAdmin` toggle; button `act:'addUser'` → `POST /api/auth/users {username, password, is_admin}` (matches legacy admin.js:289).
- Verified: node --check; synced; deployed output carries handlers + bound inputs.

## P2 — core composer — partial (model picker done; effort + attach next)
- **Model picker** — composer `.model-btn` now `data-act="toggleModelMenu"`; a popover (reusing `.slash-menu` styling) lists models. Handlers in `live/chat.js`: `toggleModelMenu` lazily fetches `GET /api/models` and flattens `items[].models`/`models_display` → `state.live.modelList=[{mid,name,ep}]`; `setModel(mid)` sets `state.live.chat.model` (used by `createSession` on next new chat) + closes. Soft-fails to an empty menu.
- TODO next: reasoning-effort pill, and **Attach Files** (`POST /api/upload` → attach to next send).

## P2 — Attach Files — ✅ DONE
- **Composer attach** — paperclip `<label><input type=file data-upload multiple></label>` added to the composer row; a delegated `change` listener in `app.js` calls `actions.uploadAttachments(files)`.
- `uploadAttachments(files)` (live/chat.js) → `POST /api/upload` (FormData field `files`) → stores `{id,name}` in `state.pendingAttach`; rendered as removable chips above the composer (`removeAttach(id)`).
- `send()` now carries `attachments: JSON.stringify(ids)` in the stream body (the `/api/chat_stream` endpoint resolves them per backend app.py:330), allows attach-only sends, and clears `pendingAttach` after the turn.
- Verified: node --check (chat/surfaces/app); synced; deployed.
- **Reasoning-effort pill**: deferred (low value; backend effort param unconfirmed — would just be a state flag in the stream body). Not blocking.

## P3 — per-surface actions — partial (notes + calendar create done; email cluster next)
- **Notes "+ New"** (surfaces.js Notes header) → `data-act="newNote"`; handler in `live/notes.js` → `POST /api/notes {title:'Untitled note', content:''}` → reload list → select the new note (by id; doc shape now carries `id`).
- **Calendar "+ New"** (surfaces.js cal header) → `data-act="newEvent"` → focuses the natural-language quick-add input (the real create path; `clearQuick` already POSTs `/api/calendar/events`).
- Verified: node --check; synced; deployed.
- TODO next (P3 email cluster): "+ New" compose, Reply/Reply-all/Forward (`/api/email/send`,`/api/email/draft`), "✦ AI reply" (`/api/email/ai-reply`), "✦ Summarize" (`/api/email/summarize`), archive (`/api/email/archive/{uid}`); research "+ Queue".

## P3 — email cluster — ✅ DONE
- New **compose overlay** (`composeOverlay(s)` in surfaces.js): bound To/Subject/Body inputs (data-model composeTo/Subject/Body), Send + Cancel + AI-draft. Rendered when `state.composeOpen`.
- Handlers in `live/email.js`: `composeNew`, `composeReply(reply|replyall|forward)` (prefills To/Subject/quoted body from the open email), `closeCompose`, `sendEmail` → `POST /api/email/send {to,subject,body,in_reply_to}`, `composeAiDraft` → `POST /api/email/ai-reply` fills the body, `summarizeEmail` → `POST /api/email/summarize` shows an inline summary banner, `clearEmailSummary`.
- Wired buttons: list "+ New" → composeNew; reader toolbar Reply/Reply-all/Forward/✦AI-reply/✦Summarize; the bottom quick reply-bar (Draft → composeAiDraft, send → reply).
- Contracts verified against backend/email_himalaya.py (send/summarize/ai-reply payloads).
- Verified: node --check; synced; deployed.
- TODO P3 remainder: research "+ Queue"; library "New document".

## P3 — research actions — ✅ DONE (P3 complete)
- **"+ Queue"** → `data-act="startResearch"` (POST /api/research/start).
- **Done-card actions**: research.js `finish()` now stores `state.live.research.lastRid`; "↗ Visual Report" → `resReport(lastRid)`, "Discuss in chat" → `resDiscuss(lastRid)`, "Save to Library" → `go('library')` (results already auto-save to /api/research/library).
- **Library "New document"**: DEFERRED — the redesign Library is a read-only artifact browser with no editor; adding doc creation needs a new editor surface (a real build, not a no-op wiring). Noted for a future surface build.
- Verified: node --check; synced; deployed.

## P4 — session management — partial (delete done; archive + header More menu next)
- **Delete conversation** — each session row now has a ✕ (`conv-del`, its own `data-act="deleteSession"` so the delegated `closest('[data-act]')` dispatches delete, not select). Handler `deleteSession(id)` in `live/chat.js`: `window.confirm` → `DELETE /api/session/{id}` (app.py:656) → if active, reset chat → reload list. (Was: no way to delete a conversation at all.)
- TODO next: archive (`POST /api/session/{id}/archive`), and the chat-header "More" kebab — Rename (`PATCH /api/session/{id}`), Copy transcript, Export.

## P4 — conversation "More" menu — ✅ DONE (P4 core complete)
- Chat header now has a **⋯ kebab** (`toggleChatMenu`) → dropdown:
  - **Rename** (`renameSession`) → `window.prompt` → `PATCH /api/session/{id}` (FormData `name`, matches legacy) → updates title + reload.
  - **Copy transcript** (`copyTranscript`) → `navigator.clipboard.writeText` of the thread.
  - **Export as Markdown** (`exportChat`) → client-side `.md` blob download.
- Verified: node --check; synced; deployed.
- P4 remainder (OPTIONAL/deferred): bulk session management (multi-select archive/delete, sort) — a "manage mode" build, not a no-op fix. Per-conversation delete + rename already cover the core need. Archive endpoints exist (`POST /api/session/{id}/archive`) if a per-row archive is later wanted.

## P5 — workspace file management — ✅ DONE
- Files tab subtab bar gained a toolbar (companion.js `filesPane`): **New file**, **New folder**, **Upload**, **Refresh**.
- Handlers in `live/companion.js` (new `actions` export): `wsNewFile` → prompt → `POST /api/workspace/create {path}`; `wsNewFolder` → `POST /api/workspace/mkdir {path}`; `wsUpload(files)` → `POST /api/workspace/upload` (FormData files + dir); `wsRefresh` → re-`GET /api/workspace/tree`. All reload the tree after.
- Upload input wired via the app.js `change` listener (extended to handle `data-ws-upload` alongside the composer's `data-upload`).
- Contracts verified against backend/workspace_files.py.
- Verified: node --check; synced; deployed.

## P6 — settings data controls — partial (Data Backup done)
- **Export Data** (`act:'exportData'`) → `GET /api/export` → downloads the JSON backup (filename from Content-Disposition).
- **Import Data** (`act:'importData'`) → JS file picker → read + `JSON.parse` → `POST /api/import` (parsed body, matches legacy admin.js).
- Verified: node --check; synced; deployed.
- DEFERRED (lower value / need interactive-control conversion, not no-op fixes): model-endpoints add/test (`/api/model-endpoints` — needs an add form + the read-only Added Models card made interactive); fallback chips "+ add" editing; search provider selection + Test. These require converting display-only `select`/`provider`/`chips` rows into real inputs — a settings-forms build. The dispatch mechanism (P1) is in place for when they're built.

## P7 — search — ✅ DONE (client-side filters)
- Converted all 4 decorative `oc-search` divs into real bound inputs (auto-wired via the app.js `input` listener → `state[field]`), each filtering its already-loaded list live:
  - **Conversations** (`convFilter`) → filters session groups by title (drops empty groups; "No conversations match." empty state).
  - **Notes** (`notesFilter`) → filters the doc list by title (origIdx preserved so `selDoc` still maps correctly).
  - **Library** (`libQuery`) → ANDed with the existing category `libFilter`.
  - **Email** (`emailQuery`) → filters by subject/from/source (origIdx preserved for `selEmail`).
- No backend needed (mirrors the `libFilter` pattern). 
- DEFERRED: global ⌘K shortcut (needs a global keydown dispatcher in app.js — same gap as incognito shortcuts, P9) and server-side `/api/email/search` (client filter covers the loaded page).
- Verified: node --check; synced; deployed.
