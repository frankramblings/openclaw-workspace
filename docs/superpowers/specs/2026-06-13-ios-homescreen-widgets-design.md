# Gary iOS Home/Lock-Screen Widgets — Design

**Date:** 2026-06-13
**Status:** Approved (design), pending implementation plan

## Goal

Let the user launch Gary (the openclaw-workspace PWA) from the iPhone Home Screen
and Lock Screen with ChatGPT-style **quick-action launch buttons** — tap a button,
land directly in the right mode (new chat, photo attach, voice, inbox).

The "iOS app" is the existing PWA (Add-to-Home-Screen, served over Tailscale at
`https://bespin.bicolor-triceratops.ts.net:8443/`). No native app is built.

## Critical reality (why this design is shaped this way)

- **A PWA cannot provide iOS widgets.** Home Screen / Lock Screen widgets are a
  native WidgetKit capability. They come only from a native Swift app or from a
  third-party *widget-scripting* app. We use the latter.
- **ChatGPT's widgets are launch buttons, not content.** They deep-link into the
  app in a specific compose mode. We mirror that — no live data, no polling, no
  new backend endpoint.
- Mirroring launch buttons needs the PWA to understand **deep-link URL params**.
  Today it only routes by `#hash` = session id (`js/sessions.js`); it has no
  `?action=` handling. Adding that is the only code in this project.

## Architecture — three parts, two phases

The only code we write is **Part A** (small, frontend-only). Parts B and C are
on-device configuration.

### Part A — PWA deep-link params (code)

Add a boot-time reader in `frontend-overrides/app.js` that parses `?action=` once
at startup, dispatches to **existing** handlers, then strips the param from the URL
(history.replaceState) so refresh/back behave normally. `#hash` session routing is
left untouched and continues to work alongside it.

| URL | Behavior | Reuses |
|---|---|---|
| `…/?action=new` | Enter new-chat mode, focus composer (keyboard up) | new-chat-mode path (`app.js:~3695`) |
| `…/?action=photo` | New chat, then open the attach file-picker | `overflow-attach-btn` / file input |
| `…/?action=voice` | New chat, then activate STT | existing STT affordance |
| `…/?action=inbox` | Switch to the Inbox tab | existing tab switcher |
| `…/` (no param) | Unchanged — resumes last chat | existing default |

Notes:
- **Camera cannot auto-open** on load (browsers require a user gesture to trigger a
  file input). `action=photo` therefore lands the user in a new chat with the attach
  UI ready; one tap opens the camera/picker. This is a deliberate, documented limit
  — do not try to force `.click()` on the file input at boot.
- Param dispatch must run **after** the relevant UI is initialized (new-chat mode,
  tabs, attach button must exist). Implementation plan determines the exact hook
  point; the contract here is "param read once, dispatched to existing handler,
  URL cleaned."
- Lives in `frontend-overrides/` (the durable source — `frontend/` is gitignored
  build output) and ships via `sync-frontend.sh`, which bumps `CACHE_NAME`.

### Part B — Shortcuts (Phase 1: works immediately, $0, no app install)

Four built-in Shortcuts, each an "Open URL" action pointing at the Part A URLs:

- **Ask Gary** → `…:8443/?action=new`
- **Photo to Gary** → `…:8443/?action=photo`
- **Voice to Gary** → `…:8443/?action=voice`
- **Gary Inbox** → `…:8443/?action=inbox`

Placement:
- **Lock Screen:** *Ask Gary* (and optionally *Photo to Gary*) as circular
  Lock-Screen widget buttons.
- **Home Screen:** a Shortcuts widget surfacing the set.

This delivers the ChatGPT-style buttons the same day, before Part C exists.

### Part C — Scriptable (Phase 2: prettier, $0, free app)

One Scriptable JS widget reusing the **same** Part A URLs (no rework):

- **Medium Home Screen widget:** Gary logo + three tappable regions (Ask / Photo /
  Inbox). Per-element `url` is supported by Scriptable on medium/large widgets.
- **Small Home Screen widget:** single whole-widget tap → Ask (`action=new`).
- **Circular Lock Screen widget:** Gary glyph → Ask.

Scriptable is a skin over Part A; if Part A works, Part C is layout only.

## Shared limitations (apply to Parts B and C; documented, not bugs)

1. **Opens in Safari, not the standalone PWA.** iOS provides no way for a non-native
   widget to force-open an installed home-screen web app. The chrome-less standalone
   launch is only available to a native wrapper, which is explicitly out of scope.
2. **No free-text input on a widget face.** No iOS widget (native included, pre-input
   APIs) takes typed text. Buttons launch into the composer instead.
3. **Camera can't auto-pop** (see Part A note).
4. **Tailscale must be connected** on the iPhone (already true in normal use).

## Out of scope (YAGNI)

- Native Swift / WidgetKit app ($99/yr dev account + Xcode 14 on the 8GB 2014 Mini).
- Widgetsmith (cannot deep-link to a custom URL, no multi-button, no dynamic content).
- Any new backend endpoint or live/glance data on the widget — ChatGPT widgets are
  static launchers, so we stay static.

## Testing / verification

- **Part A (headless, this box):** `node --check` on the edited JS; `curl` each
  `?action=` route for HTTP 200 and confirm the SPA shell serves. **No headless
  Chrome** (standing rule — it thrashes the Mini). Behavior of the dispatched action
  is confirmed by the user on a real browser/device.
- **Parts B/C (device):** user eyeballs each button on Home + Lock screen — taps land
  in new chat (composer focused), attach-ready, STT active, and Inbox tab respectively.

## Rollout

1. Part A on a branch → `node --check` + `curl` smoke → merge → `sync-frontend.sh`
   (CACHE_NAME bump) → restart workspace LaunchAgent (user-gated; the Mini cold-boots
   slowly — single restart).
2. User builds the four Shortcuts and places them (Phase 1 done).
3. User installs Scriptable, adds the widget script, places widgets (Phase 2 done).
