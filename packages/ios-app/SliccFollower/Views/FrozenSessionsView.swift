import SwiftUI

/// The freezer rail as an iOS sheet: past sessions from the leader's
/// `/sessions/index.json`, searchable by title. Selecting one opens it
/// read-only. The desktop's 44→260px drawer maps to a sheet here, per the
/// webapp's own narrow-viewport overlay behavior.
struct FrozenSessionsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                switch appState.frozenListState {
                case .idle, .loading:
                    ProgressView("Loading past sessions…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let message):
                    ContentUnavailableView(
                        "Couldn't load sessions", systemImage: "snowflake",
                        description: Text(message))
                case .loaded(let rebuilt):
                    sessionList(rebuilt: rebuilt)
                }
            }
            .navigationTitle("Past Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear { appState.loadFrozenSessions() }
    }

    @ViewBuilder
    private func sessionList(rebuilt: Bool) -> some View {
        let filtered = FrozenSessionIndex.search(appState.frozenSessions, query: query)
        if appState.frozenSessions.isEmpty {
            ContentUnavailableView(
                "No archived sessions", systemImage: "snowflake",
                description: Text(
                    "Sessions the leader archives with “New session” will appear here.")
            )
            .accessibilityIdentifier("frozen-empty")
        } else {
            List {
                if rebuilt {
                    // The index was corrupt; the list came from a directory
                    // scan, so titles are heuristic and turn counts unknown.
                    Label(
                        "The session index was unreadable — showing recovered archives.",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("frozen-rebuilt-note")
                }
                if let error = appState.frozenOpenError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                ForEach(filtered) { entry in
                    Button {
                        appState.openFrozenSession(entry)
                        dismiss()
                    } label: {
                        HStack {
                            Image(systemName: "snowflake")
                                .foregroundStyle(Color(red: 0.23, green: 0.42, blue: 0.70))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.title)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(FrozenSessionIndex.metaLine(for: entry))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("frozen-card-\(entry.id)")
                }
            }
            .searchable(text: $query, prompt: "Search titles")
        }
    }
}

/// Banner + composer replacement while a frozen session is open. The webapp
/// tints the shell ice-blue; the SwiftUI equivalent is this tinted banner
/// bar in place of the input — read-only means the composer is gone, not
/// merely disabled.
struct FrozenSessionBanner: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "snowflake")
            VStack(alignment: .leading, spacing: 1) {
                Text("Frozen session — read-only")
                    .font(.footnote.weight(.semibold))
                if let title = appState.openFrozen?.entry.title {
                    Text(title)
                        .font(.caption)
                        .opacity(0.85)
                        .lineLimit(1)
                }
            }
            Spacer()
            Button("Back to live") {
                appState.closeFrozenSession()
            }
            .font(.footnote.weight(.semibold))
            .accessibilityIdentifier("frozen-close")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .foregroundStyle(.white)
        .background(Color(red: 0.23, green: 0.42, blue: 0.70))  // webapp's ice-blue #3b6cb2
        // No container-level accessibility id: SwiftUI stamps a container's
        // id onto its LEAVES, which would clobber `frozen-close` on the
        // button (see "Put accessibility identifiers on leaves" in CLAUDE.md).
    }
}
