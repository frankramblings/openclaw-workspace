import SwiftUI
import WebKit

/// Minimal WKWebView wrapper. Loads `url` on first appearance and reloads
/// whenever `url` changes (i.e. when a widget deep link sets a new ?action=).
struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.allowsBackForwardNavigationGestures = true
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        // Only reload when the target actually differs from what's showing.
        // (deeplink.js strips ?action= after handling, so re-tapping the same
        // action leaves web.url on the clean URL and this still re-fires.)
        if web.url != url {
            web.load(URLRequest(url: url))
        }
    }
}
