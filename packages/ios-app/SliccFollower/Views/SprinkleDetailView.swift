import SwiftUI

// MARK: - SprinkleDetailView

/// Full workbench surface hosting one sprinkle's WKWebView (opened from
/// the dock rail). The pre-dock sidebar this file once carried is gone —
/// the phone IA has no sidebar (#1802).
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
        .onChange(of: appState.sprinkleReloadGeneration[sprinkle.name]) { _ in
            Task { await load() }
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
