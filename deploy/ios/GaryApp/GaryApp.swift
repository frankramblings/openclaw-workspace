import SwiftUI

// Single source of truth for the PWA origin (Tailscale must be connected).
let BASE = "https://bespin.bicolor-triceratops.ts.net:8443"

/// Holds the URL the WebView should show. Deep links mutate this.
final class Nav: ObservableObject {
    @Published var url = URL(string: BASE)!
}

@main
struct GaryApp: App {
    @StateObject private var nav = Nav()

    var body: some Scene {
        WindowGroup {
            WebView(url: nav.url)
                .ignoresSafeArea()
                // Widget taps arrive as gary://action/<new|photo|voice|inbox>.
                // Translate to the PWA's ?action= URL; deeplink.js does the rest.
                .onOpenURL { incoming in
                    let action = incoming.lastPathComponent
                    if let u = URL(string: "\(BASE)/?action=\(action)") {
                        nav.url = u
                    }
                }
        }
    }
}
