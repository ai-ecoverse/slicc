import SwiftUI
import UIKit
import os

/// Top-level container view with a NavigationSplitView whose sidebar lists
/// chat with the dock rail beside it — the webapp's narrow-viewport IA
/// (`slicc-shell.ts` ≤560px): chat is the app, workbench surfaces overlay
/// it full-bleed, and only the 48pt dock stays tappable. There is no
/// sidebar and no split view on a phone.
struct ChatView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) private var systemScheme
    @State private var showSettings = false
    @State private var hasAppeared = false
    /// The open workbench surface; nil is the collapsed (chat-only) state.
    @State private var activeSurface: DockSurface?
    /// DEBUG fixture route (`-uiTestFixtureRoute`).
    @State private var fixtureMode = false
    /// Lifted to the shell so hook seeding and the chat toolbar snowflake
    /// share the Past Sessions sheet state.
    @State private var showFrozenSessions = false
    /// Mirror the rail to the leading edge (`-leftHandedDock` /
    /// Settings toggle) — reachability for left-handed use.
    @AppStorage("leftHandedDock") private var leftHandedDock = false

    var body: some View {
        // The rail sits BESIDE the navigation stack, not inside it: a rail
        // under the navigation bar collides with the bar's chrome (the
        // leading title in left-handed mode, the trailing controls in
        // right-handed). Outside, the bar spans only the chat column.
        HStack(spacing: 0) {
            if leftHandedDock {
                dockRail
            }
            NavigationStack {
                ZStack {
                    if fixtureMode {
                        FixtureConversationView()
                    } else {
                        ConversationView(
                            showSettings: $showSettings,
                            showFrozenSessions: $showFrozenSessions)
                    }
                    // The workbench covers the chat, not the rail — the
                    // same full-bleed overlay the web shell uses at ≤560px,
                    // so tap-active-to-collapse stays reachable.
                    if let surface = activeSurface {
                        WorkbenchHost(surface: surface)
                            .transition(.move(edge: leftHandedDock ? .leading : .trailing))
                    }
                }
            }
            if !leftHandedDock {
                dockRail
            }
        }
        // A leader theme pins the scheme to its base; unthemed follows the
        // system, like the unthemed webapp shell (#1801).
        .preferredColorScheme(appState.leaderTheme.map { $0.base == .light ? .light : .dark })
        .environment(
            \.palette,
            ThemePalette.resolve(theme: appState.leaderTheme, systemScheme: systemScheme)
        )
        .environment(\.sprinkleThemeCSS, appState.leaderTheme?.sprinkleCSSOverrides ?? "")
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(appState)
        }
        .onAppear {
            guard !hasAppeared else { return }
            hasAppeared = true
            #if DEBUG
                if let themeJson = UITestHooks.themeFixtureJson() {
                    appState.applyLeaderTheme(themeJson)
                }
                // Before the connection-state early return: screenshots
                // combine a forced state with an open surface.
                if let surface = UITestHooks.opensDockSurface() {
                    activeSurface = surface
                }
                if let targets = UITestHooks.remoteTargetsFixture() {
                    appState.remoteTargets = targets
                }
                if let forced = UITestHooks.forcedConnectionState {
                    applyForcedConnectionState(forced)
                    return
                }
                if UITestHooks.routesToFixture {
                    fixtureMode = true
                    return
                }
            #endif
            let stored = UserDefaults.standard.string(forKey: "joinUrl") ?? ""
            if stored.isEmpty {
                showSettings = true
            } else if appState.connectionState == .disconnected && appState.joinUrl.isEmpty {
                appState.joinUrl = stored
                appState.connect()
            }
        }
    }

    private var dockRail: some View {
        DockRail(active: $activeSurface, sprinkles: appState.sprinkles)
    }

    /// Composer text seeded from the `-uiTestComposerText` launch argument —
    /// screenshots and UI tests need a non-empty composer without typing.
    /// Empty (and compiled to a constant) outside DEBUG.
    static func seededComposerText() -> String {
        #if DEBUG
            return UserDefaults.standard.string(forKey: "uiTestComposerText") ?? ""
        #else
            return ""
        #endif
    }

    #if DEBUG
        /// Pin the banner to one state for a UI test. `stalled` is a connected
        /// leader that stopped answering, so it sets both fields; `streaming`
        /// is a connected leader mid-turn, unlocking the send-while-streaming
        /// affordance without a live peer.
        private func applyForcedConnectionState(_ raw: String) {
            if raw == "stalled" {
                appState.connectionState = .connected
                appState.isLeaderStalled = true
                return
            }
            if raw == "streaming" {
                appState.connectionState = .connected
                appState.isStreaming = true
                return
            }
            guard let state = ConnectionState(rawValue: raw) else { return }
            appState.connectionState = state
            if state == .reconnecting {
                appState.reconnectAttempt = 3
            }
        }
    #endif
}

// MARK: - ConversationView

/// The chat conversation column shown in the detail pane. Hosts the connection
/// status bar, scoop indicator, message list (with swipe gestures), and input bar.
struct ConversationView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette
    @Binding var showSettings: Bool
    @Binding var showFrozenSessions: Bool
    @State private var inputText = ChatView.seededComposerText()
    @State private var showNewSessionDialog = false
    /// Mirrors `ChatView` so the nav-bar clusters follow the rail to the
    /// reachable edge.
    @AppStorage("leftHandedDock") private var leftHandedDock = false

    var body: some View {
        VStack(spacing: 0) {
            // Connection status bar
            ConnectionStatusView(
                state: appState.connectionState,
                reconnectAttempt: appState.reconnectAttempt,
                isStalled: appState.isLeaderStalled,
                onTapDisconnected: { showSettings = true }
            )
            .animation(.easeInOut(duration: 0.3), value: appState.connectionState)
            .animation(.easeInOut(duration: 0.3), value: appState.isLeaderStalled)

            if let frozen = appState.openFrozen {
                // Read-only view of an archived session. The live transcript
                // and composer are replaced wholesale — read-only means the
                // composer does not exist, not that it is merely grayed out.
                // A right swipe dismisses back to live, like the back gesture.
                MessageListView(
                    messages: frozen.archive.messages,
                    isStreaming: false,
                    toolUICards: [],
                    onInlineSprinkleLick: { _, _ in }
                )
                .simultaneousGesture(frozenDismissGesture)
                FrozenSessionBanner()
            } else {
                liveConversation
            }
        }
        .background(palette.canvas)
        // The live session identifies itself through the compact switcher in
        // the corner, not through a nav title — two copies of the same scoop
        // label stacked on top of each other is what the full-width scoop
        // header used to cost.
        .navigationTitle(appState.openFrozen?.entry.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(appState.openFrozen != nil)
        .toolbar {
            identityGroup
            sessionControls
        }
        .sheet(isPresented: $showFrozenSessions) {
            FrozenSessionsView()
                .environmentObject(appState)
        }
        .onAppear {
            #if DEBUG
                if UITestHooks.opensFrozenRail { showFrozenSessions = true }
                if UITestHooks.opensFrozenSession,
                    let first = UITestHooks.frozenFixture()?.first
                {
                    appState.openFrozenSession(first)
                }
            #endif
        }
    }

    // MARK: - Toolbar

    /// The rail's edge is the reachable one, so both nav-bar clusters follow
    /// it: identity opposite the rail, session actions on the rail's side.
    private var identityPlacement: ToolbarItemPlacement {
        leftHandedDock ? .topBarTrailing : .topBarLeading
    }
    private var controlsPlacement: ToolbarItemPlacement {
        leftHandedDock ? .topBarLeading : .topBarTrailing
    }

    /// Who you are talking to: the frozen back button, or the compact
    /// cone/scoop switcher that replaced the full-width header row.
    @ToolbarContentBuilder
    private var identityGroup: some ToolbarContent {
        ToolbarItem(placement: identityPlacement) {
            if appState.openFrozen != nil {
                // While frozen, Back returns to the LIVE session — the system
                // back (which pops to the sidebar) is hidden so there is
                // exactly one back affordance and it does what it looks like.
                Button {
                    appState.closeFrozenSession()
                } label: {
                    Image(systemName: "chevron.backward")
                        .foregroundStyle(palette.ink.opacity(0.7))
                }
                .accessibilityLabel("Back to live session")
                .accessibilityIdentifier("frozen-back")
            } else {
                ScoopSwitcher()
            }
        }
    }

    /// Session-level actions. `settings` sits in the middle of the cluster in
    /// both handedness modes; the outer two mirror so New chat — the most
    /// frequent of the three — stays nearest the holding hand's edge.
    @ToolbarContentBuilder
    private var sessionControls: some ToolbarContent {
        ToolbarItemGroup(placement: controlsPlacement) {
            if appState.openFrozen != nil {
                settingsButton
            } else if leftHandedDock {
                newChatButton
                settingsButton
                frozenSessionsButton
            } else {
                frozenSessionsButton
                settingsButton
                newChatButton
            }
        }
    }

    private var newChatButton: some View {
        Button {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder),
                to: nil, from: nil, for: nil)
            showNewSessionDialog = true
        } label: {
            if appState.newSessionInFlight {
                ProgressView()
            } else {
                Image(systemName: "square.and.pencil")
                    .foregroundStyle(palette.ink.opacity(0.7))
            }
        }
        // Gated like the composer: with no usable leader the request would
        // silently vanish (requestNewSession returns when the channel cannot
        // be written).
        .disabled(
            appState.newSessionInFlight
                || appState.connectionState != .connected
                || appState.isLeaderStalled
        )
        .accessibilityLabel("New chat")
        .accessibilityIdentifier("new-chat-button")
        .modifier(NewSessionDialog(isPresented: $showNewSessionDialog))
    }

    private var settingsButton: some View {
        Button {
            showSettings = true
        } label: {
            Image(systemName: "gearshape")
                .foregroundStyle(palette.ink.opacity(0.7))
        }
        .accessibilityLabel("Settings")
        .accessibilityIdentifier("settings-button")
    }

    private var frozenSessionsButton: some View {
        Button {
            showFrozenSessions = true
        } label: {
            Image(systemName: "snowflake")
                .foregroundStyle(palette.ink.opacity(0.7))
        }
        .accessibilityLabel("Past Sessions")
        .accessibilityIdentifier("frozen-rail-button")
    }

    @ViewBuilder
    private var liveConversation: some View {
        Group {
            MessageListView(
                messages: appState.messages,
                isStreaming: appState.isStreaming,
                toolUICards: appState.toolUICards,
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
                // A message typed during a stall would be accepted into the
                // composer and lost, so block sending — but say why, rather
                // than claiming the follower is disconnected.
                isStalled: appState.isLeaderStalled,
                steersActiveScoop: appState.composerTargetsLeaderActiveScoop,
                onSend: { text, attachments, dictated in
                    appState.sendMessage(
                        text, attachments: attachments, dictated: dictated)
                    inputText = ""
                },
                onAbort: {
                    appState.abort()
                },
                onSteer: { text, attachments in
                    appState.sendMessage(text, steer: true, attachments: attachments)
                    inputText = ""
                }
            )
        }
    }

    /// Right swipe anywhere on a frozen transcript dismisses back to live —
    /// the same filter as the scoop swipe (mostly-horizontal flicks only) so
    /// vertical scrolling stays untouched.
    private var frozenDismissGesture: some Gesture {
        DragGesture(minimumDistance: 40, coordinateSpace: .local)
            .onEnded { value in
                let horizontal = value.translation.width
                let vertical = value.translation.height
                guard abs(horizontal) > abs(vertical) * 1.5 else { return }
                if horizontal > 60 {
                    appState.closeFrozenSession()
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
    @Environment(\.palette) private var palette
    @State private var messages: [ChatMessage] = ChatFixture.makeMessages()
    @State private var lastLick: String?
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
                        .foregroundStyle(palette.ink.opacity(0.7))
                        .accessibilityIdentifier("fixture-header")
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
                toolUICards: [
                    ToolUIPlaceholder(requestId: "fx-tool-ui-1", html: ChatFixture.toolUIHtml)
                ],
                onInlineSprinkleLick: { body, target in
                    let summary = describeLick(body: body, target: target)
                    Self.log.info("sprinkle lick: \(summary)")
                    lastLick = summary
                }
            )
        }
        .background(palette.canvas)
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

// MARK: - ScoopSwitcher

/// The nav-bar cone/scoop switcher. Replaces the old full-width header row:
/// the same identity (avatar + label + leader-active dot) in a nav-bar-sized
/// control, and a menu that jumps straight to a scoop instead of cycling
/// one chevron tap at a time. Swipe still cycles.
struct ScoopSwitcher: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette

    var body: some View {
        if appState.scoops.count > 1 {
            Menu {
                ForEach(appState.scoops) { scoop in
                    Button {
                        appState.selectScoop(jid: scoop.jid)
                    } label: {
                        // A menu row can only draw `Image`/`Text`, never a
                        // custom Shape, so the lucide cone cannot appear
                        // here — the row says cone or scoop in words instead.
                        Label(
                            menuTitle(for: scoop),
                            systemImage: scoop.jid == appState.selectedScoopJid
                                ? "checkmark" : "circle")
                    }
                    .accessibilityIdentifier("scoop-switch-\(scoop.jid)")
                }
            } label: {
                identityLabel
            }
            .accessibilityLabel("Switch scoop")
            .accessibilityIdentifier("scoop-switcher")
        } else {
            identityLabel
                .accessibilityIdentifier("scoop-switcher")
        }
    }

    /// Avatar + label + leader-active dot, sized to sit inside the nav bar.
    /// `.lineLimit(1)` plus a cap keeps a chatty `assistantLabel` from
    /// pushing the action cluster off the other edge.
    private var identityLabel: some View {
        HStack(spacing: 5) {
            SliccAgentAvatarView(avatar: selectedAvatar)
                .accessibilityHidden(true)
            Text(appState.selectedScoop?.assistantLabel ?? "SLICC")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(palette.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 140, alignment: .leading)
            if appState.leaderActiveScoopJid != nil,
                appState.leaderActiveScoopJid == appState.selectedScoopJid
            {
                Circle()
                    .fill(Color.green)
                    .frame(width: 6, height: 6)
            }
            if appState.scoops.count > 1 {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(palette.ink.opacity(0.5))
            }
        }
        .fixedSize()
    }

    private var selectedAvatar: SliccAgentAvatarGeometry {
        appState.selectedScoop?.avatarGeometry(sideLength: 20)
            ?? .init(type: .cone, color: "#D2691E", sideLength: 20)
    }

    /// The leader's active scoop is marked in the menu too — the dot on the
    /// closed control only speaks about the one you are looking at.
    private func menuTitle(for scoop: ScoopSummary) -> String {
        let kind = scoop.isCone ? "cone" : "scoop"
        return scoop.jid == appState.leaderActiveScoopJid
            ? "\(scoop.assistantLabel) · \(kind) · active"
            : "\(scoop.assistantLabel) · \(kind)"
    }
}

// MARK: - Preview

#Preview {
    ChatView()
        .preferredColorScheme(.dark)
        .environmentObject(AppState())
}
