// True inside the GaryWorkspace WKWebView shell (it appends "GaryNative" to the
// User-Agent; see native/ios and js/native-shell.js). That shell is already an
// installed app, so browser first-run hints ("Add to Home Screen", "your
// threads live here") must never show there.
export const isNativeShell = () => /GaryNative/.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');
