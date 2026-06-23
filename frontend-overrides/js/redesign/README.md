# Workspace redesign — Direction A ("Refined Charcoal")

A faithful, self-contained recreation of the OpenClaw workspace UI/UX redesign
(design handoff: `~/design_handoff_openclaw_workspace`). It unifies the product's
surfaces — **Chat, Inbox, Email, Calendar, Research, Library, Notes, Settings** —
under one persistent left rail plus a **tabbed, splittable right "companion"**
(Terminal / Files / Gary), replacing the old strip-of-tools + floating-window
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
| `../../redesign-assets/` | the Gary helmet avatar (outline PNG + source SVG) |
| `app.js` | state, shell assembly, event delegation, focus-preserving render loop, hash routing |
| `surfaces.js` | the 8 center surfaces |
| `companion.js` | adaptive companion (Terminal · Files · Gary), split mini-IDE, reveal strip, file tree |
| `data.js` | static mock data (sessions, email, inbox, calendar, library, notes, file tree, dock copy) |
| `settings-data.js` | the Settings IA — section nav + panel/card/row definitions (mirrors the real settings modal) |
| `icons.js` / `dom.js` | inline Lucide/Feather icons + tiny template helpers |

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
