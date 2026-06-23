# Findings — parity gaps & wiring issues

Append-only. One bullet per issue: `file:line` + the fix made, or `deferred — needs human: <what decision is missing>`.
Note in a bullet if a fix also requires Frank to re-run `scripts/sync-frontend.sh` (audit target is `frontend/`, deployed copy is `frontend-overrides/`).

---

## STATUS — reconciled after the P0→P9 implementation (see `IMPLEMENTATION.md`)

The detailed findings below are the **audit-time** record (kept as written). Most were since **fixed**. Current status per finding:

| Finding (below) | Status |
|---|---|
| Settings surface non-interactive | ✅ **Mostly fixed** (P1 logout/password/adduser/wipe; P6 export/import; P8 launchers). ⏳ Deferred: model-endpoint/fallback/provider config **forms** (display-only select/provider/chips rows). |
| Search decorative | ✅ **Fixed** (P7 client filters; P9 ⌘K). ⏳ minor: server-side `/api/email/search`. |
| No way to delete a conversation | ✅ **Fixed** (P4, per-row ✕ → DELETE). |
| No session-management UI | ✅ **Partial** (P4 delete+rename). ⏳ Deferred: bulk multi-select/sort ("manage mode" build). |
| Per-surface action buttons unwired | ✅ **Fixed** (P3 email cluster / notes / calendar / research). |
| Incognito gone + shortcuts unwired | ✅ **Partial** (P9 ⌘K + "/" wired). ⏳ Deferred: incognito feature + ⌘⇧I (product decision). |
| No conversation-actions menu | ✅ **Fixed** (P4 ⋯ menu: rename/copy/export). |
| Composer chat-bar tools gone | ✅ **Partial** (P2 attach wired; web/shell via slash). ⏳ Deferred: RAG/TTS/doc-editor/presets + trim cb-* toggles. |
| Composer model picker + effort dead | ✅ **Model picker fixed** (P2). ⏳ Deferred: reasoning-effort pill. |
| Workspace explorer browse-only | ✅ **Fixed** (P5 new file/folder/upload/refresh). |
| Past-research actions unwired | ✅ **Fixed** (P0 resDiscuss/resReport). |
| Mobile quick-capture discards input | ✅ **Fixed** (P0 sendCapture → POST /api/notes). |
| (Minor) scroll-to-bottom button | ⏳ Deferred (nice-to-have). |
| Sidebar visibility advertises nonexistent surfaces | ⏳ Deferred (Compare/Cookbook/Gallery/Tasks surfaces still missing; toggle-trim is a product decision). |

**Still needs a human (all are surface/forms builds or product decisions — no remaining dead buttons):**
1. Settings config forms (model-endpoint add/test, fallback editing, search provider/Test).
2. Library "New document" (needs a doc-editor surface).
3. Bulk session management (multi-select/sort).
4. Reasoning-effort pill.
5. Incognito feature + ⌘⇧I.
6. Trim the "lying" visibility toggles (Sidebar Compare/Cookbook/Gallery/Tasks; Chat-Bar cb-web/doc/shell).
7. Scroll-to-bottom button.
8. (minor) server-side `/api/email/search`.

---

- **The entire redesigned Settings surface is non-interactive — every action button is dead.** None of the buttons rendered by `frontend/js/redesign/surfaces.js` for settings cards carry a `data-act` (or any class-based click handler — grep of `frontend/js/redesign/` finds none). Affected, all in surfaces.js:
    - `set-launcher` (surfaces.js:479) — **"Open Brain"** (settings-data.js:106), **"Open Scheduled jobs"** (:107), **"Open theme picker"** (:109).
    - `set-btn` via `btns()` (surfaces.js:441) — **"Export Data" / "Import Data"** (Data Backup, settings-data.js:143), plus any other `btns([...])` rows.
    - `set-btn danger` "Wipe" (surfaces.js:455) — every Danger-Zone **"Wipe …"** button (settings-data.js:144–147: wipe memory/skills/all).
    - `set-add` "+ add" (surfaces.js:439) — the **"+ add"** on every `chips()` row (e.g. Fallbacks: set-defaultAddFallback/utility/vision, model + search-provider fallbacks). Display-only.
    - `select` rows (surfaces.js:432, no `<select>`/data-act) and `provider` rows (surfaces.js:442, `set-provider` spans, no data-act) — every dropdown/provider picker (Endpoint, Model, Results, search provider, …) is display-only. The ONLY wired settings control is the `toggleUi` visibility toggle (surfaces.js:475).
  - Discovered while auditing the old memory-modal cluster (close/tabs/IO/skills, index.html:377–509): those features are intentionally relocated into Settings cards, but the cards can't actually *do* anything yet.
  - **HIGH-PRIORITY instances of this dead-button bug** (not just cosmetic): **Logout** (Account card, settings-data.js:122 → settings-logout-btn, index.html:2079) — user cannot sign out. **Wipe memory/skills/all** (Danger Zone) — destructive, and also unguarded if/when wired. **Change-password Save** (settings-pw-save, index.html:2093). These should be prioritized when wiring the Settings surface.
  - `deferred — needs human:` this is a build-out, not a one-line wiring fix. (a) The launchers have no target surface (no Brain/Scheduled/theme-picker surface exists). (b) Export/Import Data + Wipe buttons need real backend calls (and Wipe needs a confirm guard — destructive). Decide per button: build the target surface/modal, add a `data-act` + an `actions[...]` handler, and the backend endpoint. Likely >50 lines / multiple files → out of scope for a single audit iteration.
  - When fixed in `frontend-overrides/`, Frank must re-run `scripts/sync-frontend.sh` to deploy.

- **Search is decorative across the whole redesign — no search/filter works.** Every search affordance in `frontend/js/redesign/surfaces.js` is a static `<div class="oc-search">` containing only an icon + a placeholder `<span class="ph">` (and sometimes a `⌘K` `<span class="kbd">`). There is **no `<input>`, no `data-act`, no click handler, and no ⌘K/Ctrl-K keyboard handler** anywhere in `frontend/js/redesign/` (grep for metaKey/ctrlKey/`'k'`/openSearch = empty). Affected:
    - Chat conversation filter "Filter conversations… ⌘K" (surfaces.js:23).
    - Inbox "Search · INBOX" (surfaces.js:123).
    - Library "Filter library…" (surfaces.js:343).
    - Notes "Search notes…" (surfaces.js:381).
  - Old design had real search: `rail-search-btn` (index.html:825, "Search conversations (Ctrl+K)") backed by `frontend/js/search.js` + `search-chat.js`, plus a global Ctrl+K (keyboard-shortcuts.js).
  - `deferred — needs human:` decide the model per bar — in-place client filter of the already-loaded list (cheap, ~per-surface) vs. a global command-palette/search surface like the old Ctrl+K (bigger). Then convert each `oc-search` div to an input bound to a `data-model` state field + filter the rendered list, and (if keeping ⌘K) add a global keydown handler in app.js. Multi-surface; >50 lines. Fix in `frontend-overrides/` then re-run `scripts/sync-frontend.sh`.

- **No way to delete a conversation in the redesign.** Old design: `rail-delete-session` (index.html:827, "Delete session") deleted the active session. Redesign: session rows (`frontend/js/redesign/surfaces.js:45`) only have `data-act="selectSession"`; there is no delete button, no swipe-to-delete, and `apiDelete` (`live/api.js:41`) is never called against `/api/sessions/{id}` anywhere. The feature is simply absent (no dead affordance, no replacement).
  - `deferred — needs human:` is this an intentional scope cut, or should it be added? If added, it's fairly contained: a per-row delete affordance (hover button or context menu / mobile swipe) → new `deleteSession` action → `apiDelete('/api/sessions/'+id)` → refresh the session list, with a confirm guard (destructive). Confirm the DELETE endpoint contract first. Fix in `frontend-overrides/`, then re-run `scripts/sync-frontend.sh`.

- **No session-management UI in the redesign — the whole legacy sidebar chats-management toolbar is gone.** The redesign session list (`frontend/js/redesign/surfaces.js:45`) only supports picking a session (`selectSession`). The old design's sidebar chats section had a management toolbar that the redesign has no sibling for: `chats-library-btn` ("Manage Chats (Library)", index.html:871), `session-sort-btn` (:878), `auto-sort-sessions-more` (:898), `session-bulk-archive` (:915), `session-bulk-delete` (:916). (This is the same root as the rail-delete-session gap above — sessions are read/select-only in the redesign.)
  - `deferred — needs human:` decide whether to bring back session management (sort, bulk archive/delete, manage view) and in what form (inline row affordances vs. a manage mode), or accept it as an intentional simplification. Each needs an action + backend call (sort is client-side; archive/delete need endpoints + confirm guards). Multi-element; fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **Per-surface action buttons are overwhelmingly unwired (systemic).** Across `frontend/js/redesign/surfaces.js`, of the ~22 `<button class="btn…">`/`.btn-sm` action buttons, only **5 site-groups are wired** (chat-send :103 `send`; inbox triage :187/:194 `dismiss`; research :313/:324 `resetResearch`). The rest render but have **no `data-act`** and no matching action — clicking them does nothing:
    - **Email:** "+ New" compose (:122), "Reply"/"Reply all"/"Forward" (:147–149), "✦ AI reply"/"✦ Summarize" (:151–152), reader "✦ Draft"/quick-send (:165–166). `live/email.js` only defines `selEmail`/`mOpenReader`.
    - **Calendar:** "Today" (:250), "+ New" event (:255).
    - **Research:** "+ Queue" (:306), report actions "↗ Visual Report"/"Discuss in chat"/"Save to Library" (:326).
    - **Notes:** "+ New" note (:380).
  - Legacy siblings these break parity for include `email-compose-btn` (index.html:955) and more (reply/forward, new-event, new-note) pending their rows.
  - `deferred — needs human:` each needs an `actions[...]` handler + (mostly) a backend call — compose/reply (draft + send via the mail API), new calendar event, new note, research queue/report export. Decide scope; these are feature builds, not one-line wirings. Fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **Incognito / "Nobody" mode is gone, and the documented keyboard shortcuts aren't wired.** Old design had `incognito-indicator` (index.html:1100) — a working privacy/Nobody mode toggle (⌘⇧I). Redesign: no incognito indicator/toggle/behaviour anywhere in `frontend/js/redesign/`; only a dead settings visibility toggle `ca-incognito` (settings-data.js:111) and a decorative shortcut card listing ⌘⇧I + "/" (settings-data.js:118). The redesign has **no keyboard-shortcut handlers** at all except Enter-to-send (app.js:220) — so every shortcut the Settings → Shortcuts card advertises (⌘⇧I incognito, ⌘K search, "/" focus composer, etc.) is non-functional.
  - `deferred — needs human:` (a) decide whether to reimplement incognito/Nobody mode (privacy feature — needs UI + state + likely server flag); (b) either wire the advertised shortcuts (add a global keydown dispatcher in app.js) or stop advertising them in the Shortcuts card. Fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **No conversation-actions menu in the redesign chat header.** Old chat header had a "More" dropdown (`export-dl-btn`, index.html:1101) with: rename conversation (`export-rename-btn`), copy (`export-copy-btn`), export as PDF (`export-pdf-btn`), export as doc (`export-doc-btn`). Redesign chat header (`frontend/js/redesign/surfaces.js:78–83`) renders only title + subtitle — no kebab/More menu, no rename/copy/export actions anywhere.
  - `deferred — needs human:` decide whether to restore per-conversation actions (rename / copy transcript / export PDF+doc) as a header kebab menu. Each needs an action + backend (rename endpoint, transcript serialization, PDF/doc export). Feature build; fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **Composer reimagined: most legacy chat-bar tools are gone, but Settings → Chat Bar still advertises them.** The old composer had an overflow "+" tools menu (index.html:1166) with Attach Files (overflow-attach-btn:1173), Document Editor (overflow-doc-btn:1177), RAG (overflow-rag-btn:1183), TTS (overflow-tts-btn:1196), Presets (overflow-preset-btn:1201), plus inline Web Search / Shell. The redesign composer (`frontend/js/redesign/surfaces.js:91–103`) has only: `+`→slash palette (toggleSlash), context meter, reasoning-effort pill, model picker, Agent/Chat mode toggle, Send. No attach/doc/rag/tts/preset/web/shell buttons. Some functions survive as slash commands (`/run`≈shell, `/research`≈web) — but file attach, RAG, TTS, doc-editor, presets have **no sibling**. Meanwhile Settings → Chat Bar (settings-data.js:112, all default-on :170) offers visibility toggles `cb-web`, `cb-doc`, `cb-shell`, `cb-more`, `cb-attach`, `cb-research`, `cb-chars` — most pointing at composer controls that don't exist.
  - `deferred — needs human:` per legacy tool, decide reimplement-vs-drop. Attach-files is the most likely wanted (composer `<input type=file>` → upload endpoint → attach to next send). Also trim the Chat Bar visibility list to real controls. Feature builds; fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **Composer model picker and reasoning-effort pickers are dead.** The redesign composer (`frontend/js/redesign/surfaces.js:97–98`) renders a `.pill-btn` "Reasoning effort" (shows "Normal") and a `.model-btn` "Switch model" (shows the current model + chevron) — but **neither has a `data-act`**, and there is no `setModel`/`switchModel`/effort action anywhere in `frontend/js/redesign/`. Both are display-only; the user cannot change model or reasoning effort from the chat composer. Old design had `model-picker-btn` (index.html:1263, modelPicker.js) as a working selector.
  - `deferred — needs human:` wire a model picker (likely a dropdown/sheet listing available models from `/api/models`, → `setModel` action → persist on the session/next send) and an effort selector. Model list source + per-session persistence contract needed. Fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **Workspace explorer is browse-only — no file management.** The old explorer toolbar (index.html:1382–1387) had New file (`we-new-file`), New folder (`we-new-folder`), Upload (`we-upload`), Prefs (`we-prefs`), Refresh (`we-refresh`), Collapse (`we-collapse`). The redesign companion Files tab (`frontend/js/redesign/companion.js`) renders an expandable file tree (`toggleFs`) and tab/split/hide controls only — no new-file/new-folder/upload/refresh/prefs. (Collapse-panel ≈ `toggleComp` survives; the file-management actions don't.)
  - `deferred — needs human:` decide whether to add file CRUD to the redesign explorer (new file/folder, upload, refresh) — each needs an action + backend (the legacy explorer used `/api/workspace/*`). Confirm endpoints. Fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **Past-research actions ("Discuss" / "↗ Visual Report") are unwired.** In the Deep Research surface, each past-run row (`frontend/js/redesign/surfaces.js:330`) renders a "Discuss" chip (`data-act="resDiscuss"`) and a "↗ Visual Report" chip (`data-act="resReport"`), both gated on the row having an `rid`. But **neither `resDiscuss` nor `resReport` is defined** in any actions registry — `live/research.js` exports only `startResearch`/`resetResearch`, and `app.js` matches. So both chips are no-ops (the delegated dispatcher finds no handler and returns). These are orphaned `data-act` strings — the exact "data-action with no case" failure mode the audit targets.
  - `deferred — needs human:` add `resDiscuss(rid)` (open/seed a chat about that research run) and `resReport(rid)` (generate/open the visual report) to `live/research.js` actions, with the backend calls they imply. Fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **Mobile quick-capture discards input — "Send to Gary" doesn't send.** The mobile quick-capture sheet (`frontend/js/redesign/mobile/mobile-sheets.js`) has a textarea `data-model="captureDraft"` (:61) and a "Send to Gary" button (:66), but that button is wired to `data-act="closeCapture"` — same as the scrim/Cancel — which only sets `quickCaptureOpen=false` (mobile-app.js:62). `captureDraft` is never read or POSTed anywhere. So typing a capture + Send just dismisses the sheet; the content is lost.
  - `deferred — needs human:` add a real `sendCapture` action that POSTs `state.captureDraft` (+ `state.captureType`: remind/note/task) to the appropriate backend (reminder/note/task create), then clears + closes. Wire the "Send to Gary" button to it instead of closeCapture. Fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.

- **(Minor) No "scroll to bottom" jump button in the redesign chat.** Old: `scroll-bottom-btn` (index.html:1398) appeared when scrolled up. Redesign chat thread has no such affordance. Low priority — pure convenience; a small UX add (show a jump button when `scrollTop` isn't near bottom → scroll the `.chat-thread` to end). `deferred — needs human` (or just nice-to-have).

- **Settings → Sidebar "visibility" list advertises surfaces that don't exist in the redesign.** `frontend/js/redesign/settings-data.js:110` lets the user toggle visibility of: Brand, Search, New Chat, Chats, Email, Tools, Brain, Calendar, **Compare**, **Cookbook**, **Gallery**, Research, Library, Notes, **Tasks**, Theme, User, Settings (all default-on, :168). But the actual rendered icon-rail (`frontend/js/redesign/app.js:68–76`) has only **8** surfaces: chat, inbox, email, calendar, research, library, notes, settings. So the toggles for **Compare, Cookbook, Gallery, Tasks** (and Brain/Search/Tools/Theme/User as rail items) reference surfaces that were never built — toggling them shows/hides nothing. (Also: the visibility toggles themselves are part of the dead settings surface — no `data-act` wires them; see the "entire Settings surface" finding.)
  - Legacy siblings that are GENUINELY MISSING (no surface, not just a dead toggle): **Compare** (rail-compare, index.html:834 — multi-model comparison), and likely **Cookbook** (rail-cookbook:835), **Gallery** (rail-gallery:838), **Tasks** — pending their own inventory rows.
  - `deferred — needs human:` decide per feature whether to build the surface or drop it from the Sidebar visibility list. At minimum, the visibility list should not offer toggles for surfaces that don't exist. Fix in `frontend-overrides/`, re-run `scripts/sync-frontend.sh`.
