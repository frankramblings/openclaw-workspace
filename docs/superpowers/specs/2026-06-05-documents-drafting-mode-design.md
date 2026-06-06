# Documents Drafting Mode — Design

**Date:** 2026-06-05
**Status:** Approved for planning

## Goal

Evolve the existing Documents tab into a Cowork-style drafting environment: doc and chat side-by-side, the agent edits the doc directly via its native file tools, and every doc carries its own persistent conversation. Optimized for low cognitive burden — re-entry after days away costs nothing, tweaks need no copy-paste round-trips, and in-flight docs can't silently go stale.

## Pain points this removes (user-stated)

1. **Context re-establishment** — re-explaining a doc's purpose/state every session.
2. **Tweak round-trips** — copy-pasting agent output back into the doc by hand.
3. **Doc scatter** — losing track of which docs are in flight and where the current version lives.

Explicitly out of scope (not selected as pains): blank-page/template assistance, doc briefs as separate metadata. The persistent per-doc chat carries audience/tone context implicitly.

## What already exists (build on, don't rebuild)

- `backend/documents.py` — CRUD, version snapshot/restore, archive, library endpoint, session linking via frontmatter.
- `backend/vault_store.py` — docs as `.md` + frontmatter in `~/.openclaw/workspace/Documents/`, versions in `.versions/<doc-id>/`.
- `backend/bridge.py` — gateway WS bridge with `tool-events` capability declared; per-session gateway keys.
- `backend/app.py:137` — per-Library-chat session keys (`agent:main:web-<id>`); the pattern Draft mode reuses.
- `frontend/js/document.js` — tabbed doc panel; `.doc-editor-pane` is an **in-flow flex sibling** of `.chat-container` (`style.css:10742` — `position: relative`, `flex: 1`, `max-width: 70vw`). Side-by-side is already the desktop layout; chat is only hidden in doc-view on mobile.
- `frontend/js/documentLibrary.js` — searchable recent-first grid.
- `backend/inbox/` — collector pattern for surfacing actionable items.
- Gateway agent (Gary) already has file Read/Edit/Write tools, ramblebot MCP, and the himalaya skill — ambient work context requires no new plumbing.

## Architecture decision

**Files are the medium.** The agent edits the vault `.md` directly with its existing file tools; the UI refetches and re-renders when tool events touch the doc path. No bespoke edit protocol, no structured-patch tool. Version snapshots before each agent turn make direct editing safe.

Rejected alternative: a structured edit protocol (replace-section / insert-after ops emitted as structured output, applied by the backend). True live-patch Cowork feel, but requires real protocol design plus the still-TODO v4 event mapping, and teaches the agent a bespoke tool instead of its native ones. The tool-event stream already identifies which file was touched, so section-level highlight can be layered on later without architectural change.

## Components

### 1. Draft mode layout (frontend)

- A doc opened in Draft mode shows doc pane + chat pane side-by-side on desktop, roughly 50/50 (`--chat-max: 800px` already makes narrow chat reflow correctly; messages are `fit-content`/`max-width: 85%`).
- Work item: audit/remove any desktop rule hiding `.chat-container` when `body.doc-view` is active; confirm both panes render together. Mobile keeps current behavior (doc full-screen, swipe-dismiss back to chat).
- No drag-resizer in v1. Flex defaults until proven insufficient.
- Doc header chip: "last edited <relative time> · v<n>" from existing version metadata.

### 2. Per-doc chat binding

- Entering Draft mode binds the chat pane to gateway session key `agent:main:web-doc-<docid>`.
- The binding is stored in the doc's frontmatter (existing `session_id` field).
- Gateway sessions persist; `chat.history` reloads prior turns on open. **The persistent chat IS the where-I-left-off recap** — no recap generation, no new storage.
- Leaving Draft mode rebinds chat to the previously active session.

### 3. Turn loop (the heart)

When chat is doc-bound, `/api/chat_stream`:

1. **Snapshots a version** of the doc (existing version machinery) before dispatching the turn — this is the undo for direct agent edits.
2. Injects a per-turn context note into the message sent to the gateway:
   > You are co-drafting `~/.openclaw/workspace/Documents/<file>.md`. Apply requested changes directly to that file with your file tools, then reply with one short line summarizing what changed.
3. Streams as today. Frontend behavior:
   - On a `tool_call` event whose payload references the doc path → mark doc dirty, refetch, re-render with a brief highlight pulse.
   - Unconditionally refetch at `[DONE]` (fallback if tool-event payloads don't carry the path reliably).

Ambient context ("check the email thread with X and update the timeline section") works through the agent's existing ramblebot/himalaya access — prompt-side only, nothing to build.

### 4. Export to .docx

- `GET /api/document/{id}/export?format=docx` → run `pandoc` on the vault file → return as file download.
- Toolbar button in the doc pane.
- Dependency: `brew install pandoc` on the Mac mini (document in README).
- `pandoc` absent → 501 with install hint in the error body.
- Google Docs/Drive upload deferred; download-and-send closes the stated loop.

### 5. Staleness nudges (inbox collector)

- New collector in `backend/inbox/`: non-archived docs with a bound session, file mtime older than N days (default 4, configurable) → Inbox item "<title> has been sitting <n> days", linking directly into Draft mode for that doc.
- Reuses the existing collector interface exactly.

## Error handling

- **Agent edits the wrong file / mangles the doc:** pre-turn snapshot + existing restore endpoint. Doc pane refetch will surface the damage immediately rather than hiding it.
- **Tool-event payload doesn't identify the file:** the `[DONE]` refetch guarantees the doc is never stale at turn end; the live pulse is best-effort.
- **pandoc missing:** 501 + hint.
- **Stream stall:** existing chat watchdog (60s) + auto-nudge already cover doc-bound turns; no new handling.
- **Concurrent edits (user typing in doc editor while agent edits):** v1 rule — while a doc-bound turn is streaming, the doc pane is read-only (input affordances disabled). Simple and honest about the single-writer reality.

## Testing

- **pytest (backend):** snapshot-created-before-turn; export endpoint (golden-file smoke + 501 path); staleness collector (fresh doc excluded, stale doc included, archived excluded).
- **Manual smoke (frontend):** open doc in Draft mode → side-by-side renders; send a turn asking for a one-word change → doc updates without reload; reopen doc next session → chat history present; export button downloads a valid .docx. Follow the established concurrent-session smoke-test pattern (don't restart the gateway repeatedly; Mac mini cold-boot cost).

## Fast-follows (explicitly not v1)

1. **Discuss-selection chip:** select text in the doc → chip quotes it into the chat input. Removes "the third paragraph under Background…" describing entirely. Frontend-only.
2. **Section highlight on edit:** use tool-event file/section info to pulse only the changed section.
3. **Drag-resizer** for the split, if 50/50 proves wrong.
4. **Google Drive upload** for export.
