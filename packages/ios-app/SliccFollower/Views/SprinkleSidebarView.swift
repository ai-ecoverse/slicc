import SwiftUI

// MARK: - SprinkleSidebarView

/// Sidebar listing available sprinkles. Used as the leading column of
/// `NavigationSplitView` in `ChatView`.
struct SprinkleSidebarView: View {
    @EnvironmentObject var appState: AppState
    @Binding var selectedSprinkle: SprinkleSummary?

    var body: some View {
        List(selection: $selectedSprinkle) {
            Section("Chat") {
                Button {
                    selectedSprinkle = nil
                } label: {
                    HStack {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .foregroundStyle(.purple)
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
                }
                .buttonStyle(.plain)
            }

            if !appState.sprinkles.isEmpty {
                Section("Sprinkles") {
                    ForEach(appState.sprinkles) { sprinkle in
                        sprinkleRow(sprinkle)
                            .tag(sprinkle as SprinkleSummary?)
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
