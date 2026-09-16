import SwiftUI

struct FrozenSessionsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) var dismiss
    @State private var query = ""
    @State private var showNewSessionDialog = FrozenSessionsView.autoOpensNewSession()

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
        .background(Color(red: 0.23, green: 0.42, blue: 0.70))
    }
}
