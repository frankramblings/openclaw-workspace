// native-shell.js — Native shell detection: the GaryWorkspace WKWebView
// wrapper appends "GaryNative" to its UA. In that shell the web view is
// full-screen and the home-indicator safe area is real + drawable, so the
// mobile tab bar switches to true env() padding (html.native rules) instead
// of the Safari-PWA hack.
//
// Loaded as a plain (non-deferred, non-module) <script src> in <head>,
// BEFORE the stylesheets that key off html.native — it must run
// synchronously pre-render so the class is set before first paint. Do not
// add defer/async/type=module: any of those would let CSS apply before this
// runs, causing a flash of wrong layout in the native shell.
if (/GaryNative/.test(navigator.userAgent)) {
  document.documentElement.classList.add('native');
}
