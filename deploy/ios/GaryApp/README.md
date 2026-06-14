# Gary — minimal native iOS app + widget

A WKWebView window onto the Gary PWA plus a static Home/Lock-screen widget whose
buttons deep-link into the app (and thus into the PWA's `?action=` modes). ~70
lines of Swift. The app owns the `gary://` URL scheme, so widget taps open the
chrome-less WebView instead of Safari.

**Deep-link flow:** widget button → `gary://action/photo` → iOS opens this app →
`onOpenURL` → WebView loads `…:8443/?action=photo` → `deeplink.js` handles it.

## Requirements
- Xcode 15+ on a Mac, iOS **17+** deployment target (uses `containerBackground`;
  `accessoryCircular` lock-screen widgets need iOS 16+ anyway).
- The iPhone on the same Tailnet (Tailscale connected) to reach `:8443`.
- Signing: a free Apple ID works but the app expires after **7 days** (rebuild via
  Xcode to renew). An Apple Developer account ($99/yr) removes the expiry.

## One-time Xcode setup (~5 min of clicking)

1. **New app project:** Xcode → File → New → Project → **App** (SwiftUI, Swift).
   Name it `GaryApp`. Delete the auto-generated `ContentView.swift`.
2. **Add the app sources:** drag `GaryApp.swift` and `WebView.swift` into the app
   target. (Set your real Tailnet origin in `GaryApp.swift` if it ever changes.)
3. **Register the URL scheme:** select the project → app target → **Info** tab →
   expand **URL Types** → **+** → set **URL Schemes** = `gary`. (Or paste the
   `CFBundleURLTypes` block below into the target's Info plist.)
4. **Add the widget:** File → New → **Target… → Widget Extension**. Name it
   `GaryWidget`. **Uncheck** "Include Configuration App Intent" (we want a static
   widget). When asked, activate the scheme.
5. **Replace the widget source:** delete BOTH files the template generated — the
   widget body file (`GaryWidget.swift` stub) AND the `…Bundle.swift` file that
   holds a `@main struct …Bundle: WidgetBundle`. Then drag in this `GaryWidget.swift`
   (target membership = the widget extension only). This matters: our `GaryWidget`
   is itself `@main`, so if the template's `WidgetBundle` `@main` is left in the
   target you get a duplicate-`@main` compile error. Exactly one `@main` per target
   (app target: `GaryApp`; widget target: `GaryWidget`) — that's correct because
   they're separate targets.
6. **Deployment target:** set both targets to iOS 17.0 (project → each target →
   General → Minimum Deployments).
7. **Signing:** project → each target → **Signing & Capabilities** → pick your
   Team (your Apple ID). Let Xcode manage signing.
8. **Run** on your iPhone (plugged in, Developer Mode enabled). Then long-press the
   Home/Lock screen → add the **Gary** widget.

### URL scheme plist block (if you prefer editing Info plist directly)
```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>ai.openclaw.gary</string>
    <key>CFBundleURLSchemes</key>
    <array><string>gary</string></array>
  </dict>
</array>
```

## Files
- `GaryApp.swift` — `@main` app: WebView window + `onOpenURL` router.
- `WebView.swift` — `UIViewRepresentable` WKWebView wrapper.
- `GaryWidget.swift` — static widget: medium = Ask/Photo/Inbox, circular = Ask.

## Notes / limits
- No App Transport Security exception needed — `ts.net` uses real Let's Encrypt
  certs, so HTTPS to `:8443` just works.
- The WebView loads the live site each launch (no offline service worker) — fine
  for a window onto the PWA.
- The widget is intentionally static (no timeline refresh, no shared storage). If
  you later want live glance data (e.g. unread count) you'd add an App Group +
  a real `getTimeline`, but that's beyond this minimal version.
- `voice` is reachable via the app's router too (`gary://action/voice`) — it's
  just not surfaced as a 4th medium-widget button to keep the row uncrowded; add
  one `button("Voice", icon: "mic.fill", action: "voice")` if you want it.
