import SwiftUI

/// Top-level container view with a NavigationSplitView whose sidebar lists
/// available sprinkles and whose detail column is either the conversation or
/// a selected sprinkle's WKWebView.
struct ChatView: View {
    @EnvironmentObject var appState: AppState
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var selectedSprinkle: SprinkleSummary?
    @State private var showSettings = false
    @State private var hasAppeared = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SprinkleSidebarView(selectedSprinkle: $selectedSprinkle)
        } detail: {
            if let sprinkle = selectedSprinkle {
                SprinkleDetailView(sprinkle: sprinkle)
            } else {
                ConversationView(showSettings: $showSettings)
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

