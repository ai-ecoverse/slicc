import SwiftUI

/// The freezer rail as an iOS sheet: past sessions from the leader's
/// `/sessions/index.json`, searchable by title. Selecting one opens it
/// read-only. The desktop's 44→260px drawer maps to a sheet here, per the
/// webapp's own narrow-viewport overlay behavior.
struct FrozenSessionsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) var dismiss
    @State private var query = ""
    @State private var showNewSessionDialog = FrozenSessionsView.autoOpensNewSession()

    /// `-uiTestOpenNewSession YES` presents the dialog on appear —
    /// screenshots and tests without a tap. Constant false outside DEBUG.
    static func autoOpensNewSession() -> Bool {
        #if DEBUG
            return UserDefaults.standard.bool(forKey: "uiTestOpenNewSession")
        #else
            return false
        #endif
    }

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
                ToolbarItem(placement: .navigationBarLeading) {
                    // The rail's "New +": ask the leader to start a new chat.
                    // Disabled while a request is in flight — the leader
                    // single-flights too, but the phone must not queue one.
                    Button {
                        showNewSessionDialog = true
                    } label: {
                        if appState.newSessionInFlight {
                            ProgressView()
                        } else {
                            Image(systemName: "plus.circle")
                        }
                    }
                    .disabled(appState.newSessionInFlight)
                    .accessibilityLabel("New session")
                    .accessibilityIdentifier("new-session-button")
                    .modifier(
                        NewSessionDialog(
                            isPresented: $showNewSessionDialog,
                            onRequested: { dismiss() }))
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear { appState.loadFrozenSessions() }
        .onChange(of: appState.openFrozen?.entry.id) { _, opened in
            if opened != nil { dismiss() }
        }
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
                        // No dismiss here: the sheet closes via onChange only
                        // when the open SUCCEEDS, so a failed archive read
                        // shows its error in place instead of silently
                        // returning to the live transcript.
                        appState.openFrozenSession(entry)
                    } label: {
                        HStack {
                            if appState.frozenOpeningId == entry.id {
                                ProgressView()
                            } else {
                                Image(systemName: "snowflake")
                                    .foregroundStyle(Color(red: 0.23, green: 0.42, blue: 0.70))
                            }
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
                    .disabled(appState.frozenOpeningId != nil)
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
/// merely disabled. No dismiss button of its own: the top-left Back returns
/// to live and a right swipe on the transcript does the same, so the banner
/// only states what you are looking at.
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
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .foregroundStyle(.white)
        .background(Color(red: 0.23, green: 0.42, blue: 0.70))  // webapp's ice-blue #3b6cb2
    }
}
