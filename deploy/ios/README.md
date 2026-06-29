# iOS launch widgets for your workspace

> **Before you start:** replace `YOUR-WORKSPACE-HOST` throughout with your own
> workspace host (e.g. your Tailscale MagicDNS name + port, or a local IP).
> Tailscale must be connected on the iPhone for `.ts.net` addresses.

Base URL (example — replace with your own):
`https://YOUR-WORKSPACE-HOST`

The PWA reads `?action=` at boot and opens into a mode, then strips the param:

| action | lands you in |
|---|---|
| `new`   | a fresh chat, composer focused |
| `photo` | a fresh chat, attach one tap away (camera/photo) |
| `voice` | a fresh chat, mic button showing (one tap records) |
| `inbox` | the unified Inbox |

> iOS limitation: tapping a widget opens the URL in **Safari**, not the
> standalone home-screen PWA — no widget (Shortcuts, Scriptable, or Widgetsmith)
> can force-open an installed web app. Camera and mic can't auto-start either
> (browser gesture rule), so photo/voice land you one tap away.

## Phase 1 — Shortcuts (built-in, no install)

Make four shortcuts. For each: Shortcuts app -> **+** -> **Add Action** ->
**Web > Open URLs** -> paste the URL -> name it -> Done.

| Shortcut name | URL |
|---|---|
| Ask           | `https://YOUR-WORKSPACE-HOST/?action=new`   |
| Photo         | `https://YOUR-WORKSPACE-HOST/?action=photo` |
| Voice         | `https://YOUR-WORKSPACE-HOST/?action=voice` |
| Inbox         | `https://YOUR-WORKSPACE-HOST/?action=inbox` |

**Home Screen:** long-press the home screen -> **+** -> **Shortcuts** -> add the
Shortcuts widget -> pick *Ask* (or a medium widget to show several).

**Lock Screen:** long-press the Lock Screen -> **Customize** -> **Lock Screen** ->
tap the widget row -> **Shortcuts** -> add *Ask* (and *Photo*).

## Phase 2 — Scriptable (prettier, free app)

1. Install **Scriptable** from the App Store.
2. New script -> paste the contents of `workspace-widget.scriptable.js` -> name it
   anything you like (e.g. "Workspace").
3. Edit `const BASE` at the top of the script to your workspace host URL.
4. Home Screen: add a **Scriptable** widget (medium = Ask/Photo/Inbox buttons;
   small = Ask). Long-press it -> **Edit Widget** -> Script: your script name.
5. Lock Screen: add a **Scriptable** circular widget -> Script: your script name.
