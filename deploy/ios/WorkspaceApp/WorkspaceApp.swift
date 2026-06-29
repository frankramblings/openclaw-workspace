import SwiftUI

// ⚠️  Set this to your own workspace host (e.g. your Tailscale MagicDNS name or
//     local IP).  Tailscale must be connected on the device for .ts.net addresses.
let BASE = "https://YOUR-WORKSPACE-HOST"

/// Holds the URL the WebView should show. Deep links mutate this.
final class Nav: ObservableObject {
    @Published var url = URL(string: BASE)!
}

@main
struct WorkspaceApp: App {
    @StateObject private var nav = Nav()

    var body: some Scene {
        WindowGroup {
            WebView(url: nav.url)
                .ignoresSafeArea()
                // Widget taps arrive as workspace://action/<new|photo|voice|inbox>.
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
