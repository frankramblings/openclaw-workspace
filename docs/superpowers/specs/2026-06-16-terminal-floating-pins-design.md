# Floating, Pinnable, Chat-Reflowing Terminals — design

**Date:** 2026-06-16
**Status:** approved design, pre-implementation
**Surface:** openclaw-workspace frontend (Hermes overlay). Backend untouched.
**Builds on:** the attached-terminal feature ([[project_openclaw_attached_terminal]], live at `25adfc3`).

## Summary

Rework the terminal panel from a single fixed overlay that follows the active chat
into a **multi-panel manager**: terminals are fixed panels stacked on the right
edge; the chat reflows around them (no overlap); each can be **pinned** to persist
across chats and tabs; pins stack rightward. The `>_` rail icon is replaced by a
floating **Terminal pill** above the existing Files pill.

## Goals (the three asks)

1. Replace the `>_` icon in the left rail with a floating **Terminal pill** placed
   directly above the existing **Files** pill.
2. **Pin** a terminal so it stays put (floating, right-hugging) while you use other
   tabs (Email/Inbox/etc.) or other chats. Opening another chat's terminal lands it
   to the **left** of the pinned one(s); pinned always hug the right.
3. Resizing the terminal **reflows the chat** (chat grows/shrinks) instead of
   overlapping it — matching the other sidebars.

## Non-goals

- Backend changes (PTYs are already per-session; `_sessions` keyed by chat id).
- Mobile multi-panel: on ≤1100px (where the explorer + Files pill already hide via
  `hermes.css:309`) the terminal falls back to the current single full-width
  overlay; pinning/stacking is desktop-only.
- Tabs/splitting *within* one terminal panel.

## Current state (grounding)

- `frontend-overrides/js/workspace-terminal.js` — self-contained overlay; `buildDom()`
  injects `#rail-terminal` into `#icon-rail` and one `<aside id=workspace-terminal>`;
  `connect(curSession()||'global')`, follows the active chat via a 1.2s poll;
  per-panel: `#wt-screen`, `#wt-head`, `#wt-cwd`, `#wt-status`, `#wt-resize`,
  `#wt-restart`, `#wt-close`, `#wt-gary` (PR2 Gary-mode toggle).
- `frontend-overrides/workspace.css:741+` — `#workspace-terminal { position: fixed;
  right:0; width:560px; }` (overlay → overlaps chat; the #3 bug).
- The **explorer** is a flex sibling (`hermes.css:300`: `width:22%; flex-shrink:0`),
  so it already reflows the chat. The **Files pill** is `#we-reopen`
  (`hermes.css:351`: `position:fixed; right:10px; top:40px`), shown when the explorer
  is collapsed.
- Chat area: `<main id="chat-container">` (`index.html:1089`).
- Active chat id: `window.sessionModule.getCurrentSessionId()` (SPA id) — the same
  key the PTY/WS uses.

## Design

### A. Terminal launcher pill

- Stop injecting `#rail-terminal`. Instead inject a persistent floating pill
  `#wt-launch` (`position:fixed; right:10px; top:40px; z-index:50`, `--hermes-pill`
  styling, label "Terminal" + the `>_` glyph). Click → toggle the active chat's
  terminal open/closed.
- Nudge the Files pill below it: `#we-reopen { top: 74px; }` (override in
  `workspace.css`) so the two stack vertically (Terminal above Files). Both share
  `right:10px`. When the explorer is open (`#we-reopen` hidden) the Terminal pill is
  alone at `top:40px` — fine.
- The pill reflects state (e.g. an `active` class when the active chat's terminal is
  open). On ≤1100px the pill hides (parity with `#we-reopen`).

### B. Panel model — a manager keyed by chat id

Replace the single-`aside` design with a registry: `panels: Map<sessionId, Panel>`.
Each `Panel` owns its own `<aside class="wt-panel">` (header + xterm container + WS +
fit addon + status), bound to that chat's PTY (WS `/api/terminal/{sessionId}/stream`).
Reuse all the existing per-panel pieces (xterm, fit, reconnect+replay, gary toggle,
restart, resize) — now per instance instead of singletons.

**Per-panel header controls (three distinct actions — the shell outlives the panel):**
- **📌 Pin / unpin** (`.wt-pin`): pin = persist across chats/tabs (right stack);
  unpin = return to "only its own chat thread" (shows only while you're in that chat).
- **✕ Close** (`#wt-close`): **hide the panel but keep the shell alive** — disconnect
  the WS, leave the backend PTY in `_sessions`, and unpin. Reopening that chat's
  terminal (via the pill, or by pinning it again) reconnects and replays scrollback.
  Close never kills the shell.
- **🗑 End shell** (`#wt-kill`): the only destructive action — POST `/close` to
  terminate the PTY, remove the panel and registry entry.
- (Plus the existing **↻ restart** and **`#wt-gary`** Gary-mode toggle.)

**Visible set** = all **pinned** panels + the **active chat's** panel (if open and not
closed).
- Opening the active chat's terminal (via pill) creates/shows its panel.
- Switching chats: the previous active chat's panel — if **unpinned** — hides and
  disconnects its WS (PTY stays alive; reopening that chat replays scrollback). If
  **pinned**, it stays visible/connected.
- A shell only ends on **🗑 End shell** or a backend restart (PTYs are ephemeral
  across restarts by design); hidden-but-alive shells keep running (output into their
  capped buffer) until then.

**Pin state** persists in `localStorage` (`hermes-terminal-pins` = array of session
ids). Restored on load; a pinned chat's panel is recreated/shown on boot.

### C. Layout — fixed stack + chat reflow

All visible panels are `position:fixed` and **right-anchored**, stacked horizontally:

- **Order, right → left:** pinned panels (oldest pin rightmost, newer pins to its
  left), then the active unpinned panel leftmost.
- Each panel's `right` offset = a **base offset** + the sum of widths of panels to
  its right. The base offset = the explorer's width if the explorer is open, else 0
  — so when Files is open it stays rightmost and the terminal stack sits just left of
  it (no overlap). (**Open question for review:** terminals-left-of-explorer vs
  terminals-over-explorer; defaulting to left-of.)
- **Chat reflow:** the explorer (flex sibling) already shrinks the chat by its own
  width; the fixed terminals do not, so additionally set
  `#chat-container { margin-right: <Wt> }` where `<Wt>` = sum of visible terminal
  widths. Recomputed on open/close/pin/unpin/resize/chat-switch. On full-screen tabs
  the chat is covered, so the margin is moot and the fixed terminals simply float
  over the tab's right edge — the desired "floats over Email/Inbox" behavior. No tab
  detection needed.
- **Resize:** each panel keeps a left-edge drag handle (`.wt-resize`); dragging
  changes that panel's width, repositions panels to its left, and recomputes the
  chat margin. Per-panel width persists in `localStorage`
  (`hermes-terminal-width:<sessionId>` or a shared default).

### D. Lifecycle / edge cases

- **New chat with its own terminal while pinned ones exist:** the new (active,
  unpinned) panel mounts leftmost; pins keep their right positions.
- **Pinning the active panel:** it joins the pinned stack (becomes a new leftmost
  pin, per the multi-pin rule) and now persists when you navigate away.
- **Unpinning:** if it's not the active chat, it hides; if it is, it stays as the
  active unpinned panel.
- **Exited shell / WS drop / backend absent:** unchanged per-panel behavior
  (status notice, restart button, auto-reconnect + replay).
- **≤1100px:** manager renders at most one panel, full-width overlay (current
  behavior), pins/stack disabled, pill hidden.

### E. Scope

- **Rewrite** `frontend-overrides/js/workspace-terminal.js` into the manager
  (panel registry, pin state, visible-set + stack positioning, chat-margin
  reservation, pill launcher). Keep it a self-contained IIFE overlay (no module
  imports), degrade gracefully if `/api/terminal/*` is absent.
- **CSS** (`workspace.css`): `.wt-panel` (was `#workspace-terminal`), `.wt-pin`,
  `#wt-launch` pill, `#we-reopen` top nudge, the `--wt-total` chat-margin handling.
- Preserve the PR2 `#wt-gary` toggle per panel and the loopback/Serve auth (backend
  unchanged).

## Testing

Per the "no headless Chrome on this box" rule:
- `node --check` the rewritten JS (run as its own command — node is slow here, never
  chained before a git commit).
- Manual smoke on the 8443 origin (hard-reload for the new SW cache): pill opens the
  active chat's terminal above Files; resize reflows the chat (no overlap); pin →
  switch chats → pinned stays right, new chat's terminal mounts to its left; open
  Email → pinned floats over it; unpin/close behave; reopening a chat replays its
  scrollback.

## Resolved decisions

1. **Explorer + terminal coexistence:** terminals sit *left* of an open Files
   explorer (the explorer stays rightmost). (Confirmed.)
2. **Close vs end:** `✕ Close` hides the panel and **keeps the shell alive**;
   `🗑 End shell` is the only thing that kills the PTY; `📌 unpin` returns a terminal
   to its own chat thread. (Confirmed — see §B.)
