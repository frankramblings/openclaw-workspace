# Workspace redesign — Direction A ("Refined Charcoal")

A faithful, self-contained recreation of the OpenClaw workspace UI/UX redesign
(design handoff: `~/design_handoff_openclaw_workspace`). It unifies the product's
surfaces — **Chat, Inbox, Email, Calendar, Research, Library, Notes, Settings** —
under one persistent left rail plus a **tabbed, splittable right "companion"**
(Terminal / Files / the agent), replacing the old strip-of-tools + floating-window
pattern.

## How to view it

It is a **parallel entry point** — the live SPA (`index.html`) is untouched.
Open:

```
/static/index-redesign.html
```

Deep-link a surface with a hash, e.g. `/static/index-redesign.html#calendar`
(`chat·inbox·email·calendar·research·library·notes·settings`).

## What's here

| file | role |
|---|---|
| `../../index-redesign.html` | the standalone page (root `#oc-root` + module entry) |
| `../../redesign.css` | de-inlined stylesheet; tokens mirror the handoff `:root` (map onto Hermes vars for prod) |
| `../../redesign-assets/` | the agent helmet avatar (outline PNG + source SVG) |
| `app.js` | state, shell assembly, event delegation, focus-preserving render loop, hash routing |
| `surfaces.js` | the 8 center surfaces |
| `companion.js` | adaptive companion (Terminal · Files · the agent), split mini-IDE, reveal strip, file tree |
| `data.js` | static mock data (sessions, email, inbox, calendar, library, notes, file tree, dock copy) |
| `settings-data.js` | the Settings IA — section nav + panel/card/row definitions (mirrors the real settings modal) |
| `icons.js` / `dom.js` | inline Lucide/Feather icons + tiny template helpers |

## Mobile (≤768px)

Mobile is **not** a responsive reflow — it inverts the desktop model: one
surface at a time via a **bottom tab bar** (Chat · Inbox · ➕ · Email · More),
the companion demoted to a **swipe-up sheet**, and a center **quick-capture**
button. `app.js` dispatches desktop-vs-mobile by `matchMedia('(max-width: 768px)')`
and re-renders on breakpoint cross; both shells share the same `state`, action
map, data, and tokens — only chrome/layout differ.

| file (under `mobile/`) | role |
|---|---|
| `mobile.css` | phone shell styles; safe-area insets via `env(safe-area-inset-*)` |
| `mobile-app.js` | shell assembly, mobile actions, touch gestures (swipe-to-archive, pull-to-refresh) |
| `mobile-surfaces.js` | tab bar + Chat, Inbox, Email list/reader, Calendar agenda, More hub |
| `mobile-sheets.js` | companion sheet (Terminal/Files) + quick-capture sheet |
| `mobile-data.js` | mobile-only data (agenda, capture types, More cards) |

The 9 frames from the handoff are all implemented: Chat, companion sheet, Inbox
(real swipe-to-archive + pull-to-refresh), Quick capture, Email list, Email
reader (pushed, no tab bar), Calendar agenda, More hub, and Composing (keyboard
up → tab bar hides, composer lifts). Long-tail surfaces behind More
(Research/Library/Notes/Settings) **reuse the desktop renderers** in a
single-column pushed wrapper. Resize the browser ≤768px (or use device mode) to
see it; deep-link with `#capture`, `#more`, `#calendar`, etc.

## Status & next steps

This is a **high-fidelity shell with mock data** (the prototype's contribution is
the information-architecture + chrome). Backend wiring is the follow-up: reuse the
existing modules rather than re-implementing —

- **Chat / sessions** → `js/sessions.js`, `js/chat.js`, `js/stream-manager.js`
- **Companion Terminal** → `js/workspace-terminal.js` (per-chat PTY over WS)
- **Companion Files** → `js/workspace-explorer.js`
- **Inbox / Email** → `js/inbox.js`, `js/emailInbox.js`, `js/emailLibrary.js`
- **Calendar / Notes / Research** → `js/document.js` + research panel
- **Settings** → map onto the real `settings-modal` markup/handlers; accent should
  drive the existing `js/theme.js` system instead of the local `--accent` override.

It is built with this repo's vanilla-JS + plain-CSS conventions (no framework),
so each surface can be wired to real data incrementally without a rewrite.
