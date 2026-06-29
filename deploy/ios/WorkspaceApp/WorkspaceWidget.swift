import WidgetKit
import SwiftUI

// Static launcher widget. No data, no networking, no app group: every button is
// just a deep link into the workspace:// scheme that the app routes to ?action=.

struct WorkspaceEntry: TimelineEntry { let date: Date }

struct WorkspaceProvider: TimelineProvider {
    func placeholder(in context: Context) -> WorkspaceEntry { WorkspaceEntry(date: .now) }

    func getSnapshot(in context: Context, completion: @escaping (WorkspaceEntry) -> Void) {
        completion(WorkspaceEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WorkspaceEntry>) -> Void) {
        // One entry, never refreshes — the content is static buttons.
        completion(Timeline(entries: [WorkspaceEntry(date: .now)], policy: .never))
    }
}

private func link(_ action: String) -> URL { URL(string: "workspace://action/\(action)")! }

struct WorkspaceWidgetView: View {
    @Environment(\.widgetFamily) var family

    var body: some View {
        content
            .containerBackground(.fill.tertiary, for: .widget)
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryCircular:                 // Lock Screen
            // Accessory widgets are a single tap target: use widgetURL, not Link
            // (Link is ignored on accessory families).
            Image(systemName: "bubble.left.fill")
                .font(.title2)
                .widgetURL(link("new"))
        default:                                 // Home Screen medium
            HStack(spacing: 16) {
                button("Ask",   icon: "bubble.left.fill", action: "new")
                button("Photo", icon: "camera.fill",      action: "photo")
                button("Inbox", icon: "tray.fill",        action: "inbox")
            }
        }
    }

    private func button(_ label: String, icon: String, action: String) -> some View {
        Link(destination: link(action)) {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.title2)
                Text(label).font(.caption)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

@main
struct WorkspaceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "WorkspaceWidget", provider: WorkspaceProvider()) { _ in
            WorkspaceWidgetView()
        }
        .configurationDisplayName("Workspace")
        .description("Launch your workspace agent into a chat, photo, or inbox.")
        .supportedFamilies([.systemMedium, .accessoryCircular])
    }
}
