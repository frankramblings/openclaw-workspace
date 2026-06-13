# Gary iOS launch widgets

Base URL (Tailscale must be connected on the iPhone):
`https://bespin.bicolor-triceratops.ts.net:8443`

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
| Ask Gary      | `https://bespin.bicolor-triceratops.ts.net:8443/?action=new`   |
| Photo to Gary | `https://bespin.bicolor-triceratops.ts.net:8443/?action=photo` |
| Voice to Gary | `https://bespin.bicolor-triceratops.ts.net:8443/?action=voice` |
| Gary Inbox    | `https://bespin.bicolor-triceratops.ts.net:8443/?action=inbox` |

**Home Screen:** long-press the home screen -> **+** -> **Shortcuts** -> add the
Shortcuts widget -> pick *Ask Gary* (or a medium widget to show several).

**Lock Screen:** long-press the Lock Screen -> **Customize** -> **Lock Screen** ->
tap the widget row -> **Shortcuts** -> add *Ask Gary* (and *Photo to Gary*).

## Phase 2 — Scriptable (prettier, free app)

1. Install **Scriptable** from the App Store.
2. New script -> paste the contents of `gary-widget.scriptable.js` -> name it "Gary".
3. Home Screen: add a **Scriptable** widget (medium = Ask/Photo/Inbox buttons;
   small = Ask). Long-press it -> **Edit Widget** -> Script: "Gary".
4. Lock Screen: add a **Scriptable** circular widget -> Script: "Gary".
