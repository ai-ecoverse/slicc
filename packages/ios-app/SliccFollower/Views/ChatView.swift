import os
import SwiftUI

/// Top-level container view with a NavigationSplitView whose sidebar lists
/// chat / browser tabs / sprinkles and whose detail column shows the selected
/// route (conversation, tabs carousel, or a sprinkle's WKWebView).
struct ChatView: View {
    @EnvironmentObject var appState: AppState
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var route: DetailRoute? = .conversation
    @State private var showSettings = false
    @State private var hasAppeared = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SprinkleSidebarView(route: $route)
        } detail: {
            switch route {
            case .conversation, .none:
                ConversationView(showSettings: $showSettings)
            case .fixture:
                FixtureConversationView()
            case .tabs:
                TabsCarouselView()
            case let .sprinkle(name):
                if let sprinkle = appState.sprinkles.first(where: { $0.name == name }) {
                    SprinkleDetailView(sprinkle: sprinkle)
                } else {
                    ConversationView(showSettings: $showSettings)
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(appState)
        }
        .onAppear {
            guard !hasAppeared else { return }
            hasAppeared = true
            let stored = UserDefaults.standard.string(forKey: "joinUrl") ?? ""
            if stored.isEmpty {
                showSettings = true
            } else if appState.connectionState == .disconnected && appState.joinUrl.isEmpty {
                appState.joinUrl = stored
                appState.connect()
            }
        }
    }
}

// MARK: - ConversationView

/// The chat conversation column shown in the detail pane. Hosts the connection
/// status bar, scoop indicator, message list (with swipe gestures), and input bar.
struct ConversationView: View {
    @EnvironmentObject var appState: AppState
    @Binding var showSettings: Bool
    @State private var inputText = ""

    private let background = Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255)

    var body: some View {
        VStack(spacing: 0) {
            // Connection status bar
            ConnectionStatusView(
                state: appState.connectionState,
                onTapDisconnected: { showSettings = true }
            )
            .animation(.easeInOut(duration: 0.3), value: appState.connectionState)

            // Scoop indicator + tap-to-cycle.
            if appState.scoops.count > 1 {
                ScoopHeaderView()
                    .padding(.vertical, 6)
                    .background(background.opacity(0.85))
            }

            MessageListView(
                messages: appState.messages,
                isStreaming: appState.isStreaming,
                onInlineSprinkleLick: { body, target in
                    appState.sendSprinkleLick("inline", body: body, targetScoop: target)
                }
            )
            // simultaneousGesture so the inner ScrollView keeps vertical scrolling;
            // we only react to mostly-horizontal flicks (filtered in onEnded).
            .simultaneousGesture(swipeGesture)

            InputBar(
                text: $inputText,
                isStreaming: appState.isStreaming,
                isConnected: appState.connectionState == .connected,
                onSend: { text in
                    appState.sendMessage(text)
                    inputText = ""
                },
                onAbort: {
                    appState.abort()
                }
            )
        }
        .background(background)
        .navigationTitle(appState.selectedScoop?.assistantLabel ?? "SLICC")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button(action: { showSettings = true }) {
                    Image(systemName: "gearshape")
                        .foregroundStyle(.white.opacity(0.7))
                }
            }
        }
    }

    /// Horizontal drag gesture that routes to AppState's swipe handlers.
    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 40, coordinateSpace: .local)
            .onEnded { value in
                let horizontal = value.translation.width
                let vertical = value.translation.height
                guard abs(horizontal) > abs(vertical) * 1.5 else { return }
                if horizontal < -60 {
                    // Swipe left → next scoop
                    appState.swipeToNextScoop()
                } else if horizontal > 60 {
                    // Swipe right → previous scoop (cone fallback)
                    appState.swipeToPreviousScoop()
                }
            }
    }
}

// MARK: - FixtureConversationView

/// Synthetic chat conversation rendered from `ChatFixture.makeMessages()`.
/// Lives alongside the live `ConversationView` so designers can preview
/// every chat variant without disconnecting from the leader. Lick taps
/// log to the console — there's no scoop on the other end of the bridge.
struct FixtureConversationView: View {
    @State private var messages: [ChatMessage] = ChatFixture.makeMessages()
    @State private var lastLick: String?
    private let background = Color(red: 0x0F / 255, green: 0x0F / 255, blue: 0x1A / 255)
    private static let log = Logger(subsystem: "com.slicc.follower", category: "Fixture")

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "paintbrush.pointed.fill")
                    .foregroundStyle(.pink)
                if let lastLick {
                    Text("lick → \(lastLick)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.pink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Text("UI Fixture — synthetic session")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.7))
                }
                Spacer()
                Button("Reload") {
                    messages = ChatFixture.makeMessages()
                    lastLick = nil
                }
                .font(.caption)
                .buttonStyle(.bordered)
                .tint(.pink)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.pink.opacity(0.10))

            MessageListView(
                messages: messages,
                isStreaming: messages.last?.isStreaming == true,
                onInlineSprinkleLick: { body, target in
                    let summary = describeLick(body: body, target: target)
                    Self.log.info("sprinkle lick: \(summary)")
                    lastLick = summary
                }
            )
        }
        .background(background)
        .navigationTitle("UI Fixture")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Format a lick body for the on-screen indicator. Surfaces `action`
    /// keys so it's obvious which button just fired.
    private func describeLick(body: AnyCodable?, target: String?) -> String {
        let action: String = {
            guard let value = body?.value else { return "—" }
            if let s = value as? String { return s }
            if let dict = value as? [String: Any], let a = dict["action"] as? String { return a }
            return String(describing: value)
        }()
        if let target { return "\(action) (→\(target))" }
        return action
    }
}

// MARK: - ScoopHeaderView

/// Slim header showing the currently-viewed scoop with chevron buttons for
/// manual prev/next switching (in addition to swipe gestures).
struct ScoopHeaderView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        HStack(spacing: 12) {
            Button {
                appState.swipeToPreviousScoop()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 14, weight: .semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .foregroundStyle(.white.opacity(0.6))
            }

            Spacer()

            HStack(spacing: 6) {
                Image(systemName: appState.selectedScoop?.isCone == true
                      ? "cup.and.saucer.fill"
                      : "circle.grid.2x2")
                    .foregroundStyle(.purple)
                Text(appState.selectedScoop?.assistantLabel ?? "—")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                if let active = appState.leaderActiveScoopJid,
                   active == appState.selectedScoopJid {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 6, height: 6)
                }
            }

            Spacer()

            Button {
                appState.swipeToNextScoop()
            } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .padding(.horizontal, 14)
    }
}

// MARK: - Preview

#Preview {
    ChatView()
        .preferredColorScheme(.dark)
        .environmentObject(AppState())
}

