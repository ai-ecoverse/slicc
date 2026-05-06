import SwiftUI

// MARK: - DetailRoute

/// Discriminator for what to show in the NavigationSplitView's detail column.
enum DetailRoute: Hashable {
    case conversation
    /// Synthetic chat session for design iteration. DEBUG-only sidebar entry.
    case fixture
    case tabs
    case sprinkle(name: String)
}

// MARK: - SprinkleSidebarView

/// Sidebar listing chat / browser tabs / sprinkles. Used as the leading column
/// of `NavigationSplitView` in `ChatView`.
struct SprinkleSidebarView: View {
    @EnvironmentObject var appState: AppState
    @Binding var route: DetailRoute?

    var body: some View {
        // Optional selection binds directly so popping the detail (back nav
        // on compact) clears it and shows the sidebar instead of immediately
        // re-pushing a default route.
        List(selection: $route) {
            Section("Chat") {
                conversationRow
                    .tag(DetailRoute.conversation)
                #if DEBUG
                fixtureRow
                    .tag(DetailRoute.fixture)
                #endif
            }

            Section("Browser") {
                tabsRow
                    .tag(DetailRoute.tabs)
            }

            if !appState.sprinkles.isEmpty {
                Section("Sprinkles") {
                    ForEach(appState.sprinkles) { sprinkle in
                        sprinkleRow(sprinkle)
                            .tag(DetailRoute.sprinkle(name: sprinkle.name))
                    }
                }
            } else {
                Section {
                    Label("No sprinkles available", systemImage: "sparkles")
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("SLICC")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    appState.refreshSprinkles()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(appState.connectionState != .connected)
            }
        }
        .refreshable {
            appState.refreshSprinkles()
        }
    }

    // MARK: - Rows

    @ViewBuilder
    private var conversationRow: some View {
        HStack {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .foregroundStyle(.purple)
                .frame(width: 22)
            Text("Conversation")
                .foregroundStyle(.primary)
            Spacer()
            if let activeJid = appState.leaderActiveScoopJid,
               let active = appState.scoops.first(where: { $0.jid == activeJid }) {
                Text(active.assistantLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }

    #if DEBUG
    @ViewBuilder
    private var fixtureRow: some View {
        HStack {
            Image(systemName: "paintbrush.pointed.fill")
                .foregroundStyle(.pink)
                .frame(width: 22)
            Text("UI Fixture")
                .foregroundStyle(.primary)
            Spacer()
            Text("DEBUG")
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.pink.opacity(0.18)))
        }
        .contentShape(Rectangle())
    }
    #endif

    @ViewBuilder
    private var tabsRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "rectangle.stack.fill")
                .foregroundStyle(.blue)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("Tabs")
                    .foregroundStyle(.primary)
                if let primary = appState.cdpTargets.first {
                    Text(primary.title.isEmpty ? primary.url : primary.title)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            if !appState.cdpTargets.isEmpty {
                Text("\(appState.cdpTargets.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.blue.opacity(0.4)))
            }
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func sprinkleRow(_ sprinkle: SprinkleSummary) -> some View {
        HStack(spacing: 10) {
            Image(systemName: sprinkle.open ? "sparkles" : "square.grid.2x2")
                .foregroundStyle(sprinkle.open ? .yellow : .blue)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(sprinkle.title)
                    .font(.body)
                Text(sprinkle.name)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if sprinkle.open {
                Circle()
                    .fill(Color.green)
                    .frame(width: 6, height: 6)
            }
        }
        .contentShape(Rectangle())
    }
}

// MARK: - SprinkleDetailView

/// Detail view for a selected sprinkle. Loads the .shtml content from the
/// leader (chunked fetch) and renders it inside `SprinkleWebView`.
struct SprinkleDetailView: View {
    @EnvironmentObject var appState: AppState
    let sprinkle: SprinkleSummary
    @State private var content: String?
    @State private var error: String?
    @State private var isLoading = false

    var body: some View {
        Group {
            if let content = content {
                SprinkleWebView(
                    sprinkleName: sprinkle.name,
                    sprinkleTitle: sprinkle.title,
                    sprinkleContent: content,
                    updates: appState.sprinkleUpdates[sprinkle.name],
                    onLick: { body, targetScoop in
                        appState.sendSprinkleLick(
                            sprinkle.name,
                            body: body,
                            targetScoop: targetScoop
                        )
                    },
                    onClose: {
                        // Closing a sprinkle from inside the webview just clears
                        // the content here — the user can pick another one.
                        self.content = nil
                    }
                )
                .ignoresSafeArea(.container, edges: .bottom)
            } else if let error = error {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 32))
                        .foregroundStyle(.orange)
                    Text("Failed to load sprinkle")
                        .font(.headline)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                    Button("Retry") {
                        Task { await load() }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView("Loading sprinkle…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(sprinkle.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: sprinkle.id) {
            await load()
        }
    }

    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        error = nil
        content = nil
        do {
            let raw = try await appState.fetchSprinkleContent(sprinkle.name)
            content = raw
        } catch {
            self.error = error.localizedDescription
        }
    }
}
