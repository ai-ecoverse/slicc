import SwiftUI
import WebKit

// MARK: - TabsCarouselView

/// Horizontal paged carousel of locally-hosted CDP targets (one WKWebView per
/// page). Driven by `AppState.cdpTargets` and the bridge's underlying webviews.
///
/// Used as the detail column when the sidebar's "Tabs" entry is selected.
struct TabsCarouselView: View {
    @EnvironmentObject var appState: AppState
    @State private var selectedTabId: String?
    @State private var showingNewTabPrompt = false
    @State private var newTabUrlInput: String = "https://"

    @Environment(\.palette) private var palette

    private var canControlTabs: Bool {
        appState.connectionState == .connected
    }

    /// Tabs living elsewhere in the tray (leader / other followers).
    /// Remote pages cannot be hosted live here, so they render as preview
    /// cards — screenshots captured over follower-originated CDP (#1865).
    /// Local tabs stay live WKWebViews in the carousel above.
    @ViewBuilder
    private var remoteList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                remoteHeader
                ForEach(appState.remoteTargets, id: \.targetId) { target in
                    RemoteTabCard(target: target)
                }
            }
            .padding(12)
        }
    }

    @ViewBuilder
    private var remoteStrip: some View {
        VStack(alignment: .leading, spacing: 6) {
            remoteHeader
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(appState.remoteTargets, id: \.targetId) { target in
                        RemoteTabCard(target: target)
                            .frame(width: 240)
                    }
                }
                .padding(.horizontal, 12)
            }
        }
        .padding(.vertical, 8)
        .background(palette.surface)
    }

    private var remoteHeader: some View {
        Text("Elsewhere in the tray")
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.inkSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
    }

    var body: some View {
        Group {
            if appState.cdpTargets.isEmpty && appState.remoteTargets.isEmpty {
                emptyState
            } else if appState.cdpTargets.isEmpty {
                remoteList
            } else {
                VStack(spacing: 0) {
                    pagedCarousel
                    if !appState.remoteTargets.isEmpty {
                        remoteStrip
                    }
                }
            }
        }
        .background(palette.canvas)
        .navigationTitle(currentTabTitle())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button {
                    presentNewTabPrompt()
                } label: {
                    Image(systemName: "plus.square.on.square")
                }
                .disabled(!canControlTabs)
                if let tabId = effectiveSelectedTabId() {
                    Button(role: .destructive) {
                        appState.cdpCloseTab(tabId)
                        selectedTabId = nil
                    } label: {
                        Image(systemName: "xmark.square")
                    }
                    .disabled(!canControlTabs)
                }
            }
        }
        .alert("New tab", isPresented: $showingNewTabPrompt) {
            TextField("URL", text: $newTabUrlInput)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .keyboardType(.URL)
            Button("Open") {
                openNewTab(from: newTabUrlInput)
            }
            Button("Blank") {
                appState.cdpOpenTab(url: "about:blank")
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Enter the URL to load. Leave as-is or pick Blank for an empty page.")
        }
    }

    private func presentNewTabPrompt() {
        let trimmed = newTabUrlInput.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed == "https://" || trimmed == "about:blank" {
            newTabUrlInput = "https://"
        }
        showingNewTabPrompt = true
    }

    private func openNewTab(from raw: String) {
        let normalized = Self.normalizeUrl(raw)
        appState.cdpOpenTab(url: normalized)
    }

    /// Coerce user input into a loadable URL: empty → about:blank,
    /// missing scheme → prepend https://.
    static func normalizeUrl(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "https://" || trimmed == "http://" {
            return "about:blank"
        }
        if trimmed.contains("://") || trimmed.hasPrefix("about:") || trimmed.hasPrefix("data:") {
            return trimmed
        }
        return "https://\(trimmed)"
    }

    // MARK: - Empty state

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "rectangle.stack.badge.plus")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No browser tabs")
                .font(.headline)
            Text(
                canControlTabs
                    ? "The leader can drive WKWebView tabs over the CDP bridge — they appear here as a paged carousel. You can also open a blank tab manually."
                    : "Connect to a leader (Settings → Join URL) to host browser tabs here."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 40)
            Button {
                presentNewTabPrompt()
            } label: {
                Label("Open new tab…", systemImage: "plus.square.on.square")
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canControlTabs)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Paged carousel

    @ViewBuilder
    private var pagedCarousel: some View {
        let binding = Binding<String>(
            get: { effectiveSelectedTabId() ?? appState.cdpTargets.first?.id ?? "" },
            set: { selectedTabId = $0 }
        )
        TabView(selection: binding) {
            ForEach(appState.cdpTargets) { target in
                tabPage(target)
                    .tag(target.id)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .always))
        .indexViewStyle(.page(backgroundDisplayMode: .always))
    }

    @ViewBuilder
    private func tabPage(_ target: CDPTargetSummary) -> some View {
        VStack(spacing: 0) {
            tabHeader(target)
            Divider().background(Color.white.opacity(0.08))
            if let webView = appState.cdpWebView(for: target.id) {
                CDPTargetWebView(webView: webView)
            } else {
                ProgressView("Tab unavailable")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder
    private func tabHeader(_ target: CDPTargetSummary) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "globe")
                .foregroundStyle(.blue)
            // Title over origin, not title over full URL: a phone-width
            // header cannot show a real URL and the truncated middle of one
            // is unreadable noise.
            VStack(alignment: .leading, spacing: 1) {
                Text(target.title.isEmpty ? "Untitled" : target.title)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Text(RemoteTabCard.displayHost(target.url))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer()
            Button {
                appState.cdpBridgeReload(target.id)
            } label: {
                Image(systemName: "arrow.clockwise")
                    .foregroundStyle(palette.ink.opacity(0.7))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(palette.surface)
    }

    // MARK: - Helpers

    private func effectiveSelectedTabId() -> String? {
        if let id = selectedTabId, appState.cdpTargets.contains(where: { $0.id == id }) {
            return id
        }
        return appState.cdpTargets.first?.id
    }

    private func currentTabTitle() -> String {
        guard let id = effectiveSelectedTabId(),
            let target = appState.cdpTargets.first(where: { $0.id == id })
        else {
            return "Tabs"
        }
        if !target.title.isEmpty { return target.title }
        if !target.url.isEmpty { return target.url }
        return "Tabs"
    }
}

// MARK: - CDPTargetWebView

/// SwiftUI wrapper that adopts an existing `WKWebView` (owned by `CDPBridge`)
/// as the only subview of a container UIView. Reparenting is idempotent.
struct CDPTargetWebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        attach(webView, to: container)
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // Re-adopt if SwiftUI recycled the cell or the webView was moved.
        if webView.superview !== uiView {
            attach(webView, to: uiView)
        }
    }

    private func attach(_ webView: WKWebView, to container: UIView) {
        webView.removeFromSuperview()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
    }
}
