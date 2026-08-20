import SliccTrayKit
import SwiftUI
import UIKit
import os

/// Top-level adaptive shell. Compact width preserves the webapp's narrow IA:
/// chat is the app, workbench surfaces overlay it full-bleed, and only the
/// 48pt dock stays tappable. Regular width keeps chat visible beside the
/// selected workbench surface, except while a browser tab claims the window.
struct ChatView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var inboundActions: InboundActionCoordinator
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.openURL) private var openURL
    @StateObject private var presentation: ChatPresentationState
    @StateObject private var ptt = PttController(
        engine: InputBar.makeDictationEngine(),
        prepareForRecording: { VoiceReply.shared.stopSpeaking() })
    @State private var showSettings = false
    @State private var hasAppeared = false
    /// DEBUG fixture route (`-uiTestFixtureRoute`).
    @State private var fixtureMode = false
    /// Lifted to the shell so hook seeding and the chat toolbar snowflake
    /// share the Past Sessions sheet state.
    @State private var showFrozenSessions = false
    /// Mirror the rail to the leading edge (`-leftHandedDock` /
    /// Settings toggle) — reachability for left-handed use.
    @AppStorage("leftHandedDock") private var leftHandedDock = false
    /// Hosts the user chose to always open without the card, comma-joined.
    @AppStorage("inboundAlwaysOpenHosts") private var alwaysOpenHosts = ""
    /// Opt-in unattended prompts: the user made this policy call
    /// explicitly by choosing Always on the prompt card.
    @AppStorage("inboundAlwaysAllowPrompts") private var alwaysAllowPrompts = false
    /// Transcript links stay in Sliccy's own browser by default — a tap on a
    /// link the agent sent should not evict the user from the session.
    /// Settings → Advanced hands them back to the system browser.
    @AppStorage("openLinksInBuiltInBrowser") private var openLinksInBuiltInBrowser = true

    init() {
        _presentation = StateObject(
            wrappedValue: ChatPresentationState(composerDraft: Self.seededComposerText()))
    }

    /// Test seam for proving the shell, rather than either adaptive branch,
    /// constructs and owns the presentation state.
    init(presentation: @autoclosure @escaping () -> ChatPresentationState) {
        _presentation = StateObject(wrappedValue: presentation())
    }

    var body: some View {
        GeometryReader { geometry in
            switch ShellLayout.mode(
                horizontalSizeClass: horizontalSizeClass,
                availableWidth: geometry.size.width
            ) {
            case .compactOverlay:
                compactShell
            case .regularSplit:
                regularShell
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
        // Typing is the scrutiny channel: one raised lower lid per keystroke,
        // and any keystroke also wakes an avatar that has drowsed off waiting.
        .onChange(of: presentation.composerDraft) { _, _ in
            appState.avatarExpression.scrutinize()
            appState.avatarExpression.wake()
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(appState)
        }
        .onAppear {
            guard !hasAppeared else { return }
            hasAppeared = true
            #if DEBUG
                if let launchJoinUrl = UITestHooks.launchJoinUrl {
                    appState.joinUrl = launchJoinUrl
                }
                if let themeJson = UITestHooks.themeFixtureJson() {
                    appState.applyLeaderTheme(themeJson)
                }
                // Before the connection-state early return: screenshots
                // combine a forced state with an open surface.
                if let surface = UITestHooks.opensDockSurface() {
                    presentation.activeSurface = surface
                    presentation.terminalWasOpened = surface == .term
                }
                if let targets = UITestHooks.remoteTargetsFixture() {
                    appState.remoteTargets = targets
                }
                if let inboundURL = UITestHooks.inboundOpenURL {
                    _ = inboundActions.receive(url: inboundURL, needsConfirmation: true)
                }
                // Armed before the early returns below: a blip is staged on
                // top of whichever start state those apply.
                scheduleConnectionBlip()
                if UITestHooks.scriptCompletedTurn(into: appState) {
                    return
                }
                if let forced = UITestHooks.forcedConnectionState {
                    applyForcedConnectionState(forced)
                    return
                }
                if UITestHooks.routesToFixture {
                    fixtureMode = true
                    return
                }
                if !appState.joinUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    appState.connect()
                    return
                }
            #endif
            // A remembered session outranks the Settings sheet: reconnect to
            // the last-good tray first and only open Settings when there is
            // nothing to try. A dead session lands in .gaveUp, which opens
            // Settings on appear and through the handler below. The stored
            // attempt deliberately ignores whatever text sits in the Join URL
            // field — leftover typing must not strand the launch with neither
            // a connection nor Settings (review finding).
            if appState.connectionState == .gaveUp {
                showSettings = true
            } else if appState.connectionState == .disconnected {
                if !appState.attemptStoredConnection() && appState.joinUrl.isEmpty {
                    showSettings = true
                }
            }
        }
        .onChange(of: appState.connectionState) { _, state in
            if state == .gaveUp { showSettings = true }
        }
        .onChange(of: presentation.activeSurface) { surface in
            if surface == .term { presentation.terminalWasOpened = true }
        }
        .onChange(of: appState.leaderOpenedTabId) { _, tabId in
            presentLeaderOpenedTab(tabId)
        }
        .overlay(alignment: .top) {
            inboundPhaseChip
        }
        .alert(
            "Open in Sliccy's browser?",
            isPresented: inboundOpenAlertPresented,
            presenting: inboundActions.pendingOpen
        ) { action in
            Button("Open") { executeInboundOpen(action) }
            if let host = action.url.host() {
                Button("Always Allow \(host)") {
                    allowHostAlways(host)
                    executeInboundOpen(action)
                }
            }
            Button("Cancel", role: .cancel) { inboundActions.consume(action) }
        } message: { action in
            Text(action.url.absoluteString)
        }
        .alert(
            "Send this prompt to Sliccy?",
            isPresented: inboundPromptAlertPresented,
            presenting: inboundActions.pendingPrompt
        ) { action in
            Button("Send") { executeInboundPrompt(action) }
            Button("Always Send") {
                alwaysAllowPrompts = true
                executeInboundPrompt(action)
            }
            Button("Cancel", role: .cancel) { cancelInboundPrompt(action) }
        } message: { action in
            Text(action.prompt)
        }
        .onChange(of: inboundActions.pendingOpen) { action in
            // The App-Intent route was an explicit user action, and an
            // always-allowed host carries a standing decision — both
            // execute without the card. Other deep links keep it.
            if let action, !action.needsConfirmation || hostAlwaysAllowed(action.url) {
                executeInboundOpen(action)
            }
        }
        .onChange(of: inboundActions.pendingPrompt) { action in
            if let action, !action.needsConfirmation || alwaysAllowPrompts {
                executeInboundPrompt(action)
            }
        }
        .onChange(of: inboundActions.pendingTranscript) { request in
            if let request {
                executeTranscriptExport(request)
            }
        }
    }

    /// Bring a leader-opened tab to the front. The leader opens a tab here so
    /// a human can act on it — an auth hand-off above all — which only works
    /// if it is actually visible; before this it was created behind the chat
    /// with nothing to indicate it existed.
    private func presentLeaderOpenedTab(_ tabId: String?) {
        guard let tabId else { return }
        withAnimation {
            presentation.activeSurface = .browser
        }
        appState.browserViewingTabId = tabId
        // One-shot: consume it so a later re-render doesn't yank the user
        // back to a tab they have already navigated away from.
        appState.leaderOpenedTabId = nil
    }

    // MARK: - Inbound open (#1918)

    /// The shell owns execution: open the URL as a local tab and land the
    /// user in full-screen browsing, exactly like tapping a remote card.
    private func executeInboundOpen(_ action: InboundActionCoordinator.PendingOpen) {
        inboundActions.consume(action)
        openInBuiltInBrowser(action.url)
    }

    // MARK: - Transcript links

    /// Only web links are ours to keep. `mailto:`, `tel:`, and app schemes
    /// have no meaning in a WKWebView tab, so they stay with the system even
    /// when the setting is on.
    static func routesToBuiltInBrowser(_ url: URL, enabled: Bool) -> Bool {
        guard enabled, let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// Scoped to the conversation subtree so only transcript links are
    /// redirected — the shell's own `openURL` (x-callback bounces) and the
    /// Settings sheet keep the system action.
    private var transcriptLinkAction: OpenURLAction {
        OpenURLAction { url in
            guard Self.routesToBuiltInBrowser(url, enabled: openLinksInBuiltInBrowser) else {
                return .systemAction
            }
            openInBuiltInBrowser(url)
            return .handled
        }
    }

    private func openInBuiltInBrowser(_ url: URL) {
        withAnimation {
            presentation.activeSurface = .browser
        }
        let id = appState.cdpOpenTab(url: url.absoluteString)
        appState.browserViewingTabId = id
    }

    /// System-alert presentation state: an alert is the platform's own
    /// confirmation dialog — position, width, fonts, and button colors
    /// come out of the box (and Liquid Glass on iOS 26). Escape-key or
    /// programmatic dismissal counts as Cancel: fail closed.
    private var inboundOpenAlertPresented: Binding<Bool> {
        Binding(
            get: { inboundActions.pendingOpen?.needsConfirmation == true },
            set: { presented in
                if !presented, let action = inboundActions.pendingOpen,
                    action.needsConfirmation
                {
                    inboundActions.consume(action)
                }
            }
        )
    }

    private var inboundPromptAlertPresented: Binding<Bool> {
        Binding(
            get: { inboundActions.pendingPrompt?.needsConfirmation == true },
            set: { presented in
                if !presented, let action = inboundActions.pendingPrompt,
                    action.needsConfirmation
                {
                    cancelInboundPrompt(action)
                }
            }
        )
    }

    private func cancelInboundPrompt(_ action: InboundActionCoordinator.PendingPrompt) {
        inboundActions.consume(prompt: action)
        fireCallback(action.xCancel, params: [:])
        inboundActions.resolve(id: action.id, with: .failure(InboundActionError.cancelled))
    }

    /// Standing per-host decision for deep-linked opens.
    private func hostAlwaysAllowed(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        return alwaysOpenHosts.split(separator: ",").map(String.init).contains(host)
    }

    private func allowHostAlways(_ host: String) {
        let normalized = host.lowercased()
        guard !hostAlwaysAllowed(URL(string: "https://\(normalized)")!) else { return }
        alwaysOpenHosts = alwaysOpenHosts.isEmpty ? normalized : alwaysOpenHosts + "," + normalized
    }

    private func executeInboundPrompt(_ action: InboundActionCoordinator.PendingPrompt) {
        inboundActions.consume(prompt: action)
        guard appState.connectionState == .connected, !appState.isLeaderStalled,
            let scoopJid = appState.selectedScoopJid
        else {
            fireCallback(
                action.xError, params: ["errorMessage": "Sliccy is not connected to a leader"])
            inboundActions.resolve(id: action.id, with: .failure(InboundActionError.notConnected))
            return
        }
        inboundActions.phase = .running("Waiting for Sliccy's reply…")
        let timeoutToken = appState.inboundPrompt.arm(scoopJid: scoopJid) { outcome in
            switch outcome {
            case .reply(let text):
                inboundActions.phase = nil
                fireCallback(
                    action.xSuccess, params: ["result": Self.boundedCallbackResult(text)])
                inboundActions.resolve(id: action.id, with: .success(text))
            case .failure(let message):
                inboundActions.phase = .failed(message)
                fireCallback(action.xError, params: ["errorMessage": message])
                inboundActions.resolve(
                    id: action.id, with: .failure(InboundActionError.agent(message)))
            }
        }
        Task {
            try? await Task.sleep(for: .seconds(180))
            appState.inboundPrompt.timeout(token: timeoutToken)
        }
        appState.sendMessage(action.prompt)
    }

    /// Transcript export (#1918): re-request the leader snapshot so the
    /// export is fresh, then render exactly what the phone displays.
    private func executeTranscriptExport(_ request: InboundActionCoordinator.PendingTranscript) {
        inboundActions.consume(transcript: request)
        guard appState.connectionState == .connected, !appState.isLeaderStalled else {
            inboundActions.resolve(
                id: request.id, with: .failure(InboundActionError.notConnected))
            return
        }
        inboundActions.phase = .running("Refreshing the conversation…")
        let timeoutToken = appState.inboundSnapshot.arm(
            scoopJid: appState.selectedScoopJid ?? ""
        ) {
            inboundActions.phase = nil
            let markdown = Self.transcriptMarkdown(
                label: appState.selectedScoop?.assistantLabel ?? "Sliccy",
                messages: appState.messages)
            inboundActions.resolve(id: request.id, with: .success(markdown))
        }
        Task {
            try? await Task.sleep(for: .seconds(30))
            guard appState.inboundSnapshot.timeout(token: timeoutToken) else { return }
            inboundActions.phase = nil
            inboundActions.resolve(
                id: request.id, with: .failure(InboundActionError.timedOut))
        }
        appState.requestFreshSnapshot()
    }

    /// Transient status for a running automation (and its failure) — the
    /// coordinator's phase, rendered as a quiet chip instead of a card.
    @ViewBuilder
    private var inboundPhaseChip: some View {
        if let phase = inboundActions.phase {
            HStack(spacing: 6) {
                switch phase {
                case .running(let message):
                    ProgressView().controlSize(.mini)
                    Text(message)
                case .failed(let message):
                    Image(systemName: "exclamationmark.triangle")
                    Text(message)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .accessibilityIdentifier("inbound-phase-chip")
            .transition(.opacity)
        }
    }

    /// The conversation as bounded Markdown — the same rows the screen
    /// renders, nothing more. Truncated head-first when over budget so the
    /// newest turns survive.
    static func transcriptMarkdown(label: String, messages: [ChatMessage]) -> String {
        var sections: [String] = ["# Sliccy — \(label)"]
        for message in messages {
            let heading = message.role == .user ? "## You" : "## \(label)"
            var body = message.content
            if let tools = message.toolCalls, !tools.isEmpty {
                let names = tools.map { "`\($0.name)`" }.joined(separator: ", ")
                body += "\n\n_tools: \(names)_"
            }
            sections.append("\(heading)\n\n\(body)")
        }
        var rendered = sections.joined(separator: "\n\n")
        let cap = InboundActionCoordinator.maxTranscriptBytes
        if rendered.utf8.count > cap {
            while rendered.utf8.count > cap - 32, sections.count > 2 {
                sections.remove(at: 1)
                rendered = sections.joined(separator: "\n\n")
            }
            rendered = "_older turns truncated_\n\n" + rendered
        }
        return rendered
    }

    /// Append our result parameters to the caller-supplied callback and
    /// bounce over. The callback URL and its values are never logged.
    private func fireCallback(_ url: URL?, params: [String: String]) {
        guard let url,
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return }
        if !params.isEmpty {
            components.queryItems =
                (components.queryItems ?? [])
                + params.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        if let final = components.url { openURL(final) }
    }

    /// x-callback results ride in a URL query — cap what we return rather
    /// than hand Shortcuts an unbounded string (#1918).
    static func boundedCallbackResult(_ text: String) -> String {
        text.count <= 2000 ? text : String(text.prefix(2000)) + "…"
    }

    /// Full-screen browsing: a foregrounded local tab claims the whole
    /// window — no rail, no navigation bar (Safari-shaped). The way back is
    /// the tab-overview button in the browser's own bottom bar.
    private var isBrowserFullScreen: Bool {
        presentation.activeSurface == .browser && appState.browserViewingTabId != nil
    }

    /// The phone shell stays structurally unchanged: the rail remains outside
    /// the navigation stack while the workbench overlays only the conversation.
    private var compactShell: some View {
        // The rail sits BESIDE the navigation stack, not inside it: a rail
        // under the navigation bar collides with the bar's chrome (the
        // leading title in left-handed mode, the trailing controls in
        // right-handed). Outside, the bar spans only the chat column.
        HStack(spacing: 0) {
            if leftHandedDock && !isBrowserFullScreen {
                dockRail
            }
            NavigationStack {
                ZStack {
                    if fixtureMode {
                        FixtureConversationView(
                            transcriptPosition: $presentation.transcriptPosition)
                    } else {
                        ConversationView(
                            showSettings: $showSettings,
                            showFrozenSessions: $showFrozenSessions,
                            inputText: $presentation.composerDraft,
                            stagedAttachments: $presentation.stagedAttachments,
                            transcriptPosition: $presentation.transcriptPosition,
                            ptt: ptt,
                            // The overlay covers the conversation but not
                            // the shared navigation bar, so the chat's
                            // toolbar items would keep rendering over the
                            // workbench surface and merge with any items it
                            // contributes into a synthesized `…` (#1916).
                            toolbarSuppressed: presentation.activeSurface != nil
                        )
                        .environment(\.openURL, transcriptLinkAction)
                    }
                    // The workbench covers the chat, not the rail — the
                    // same full-bleed overlay the web shell uses at ≤560px,
                    // so tap-active-to-collapse stays reachable.
                    if presentation.terminalWasOpened || presentation.activeSurface == .term {
                        WorkbenchHost(
                            surface: .term,
                            isActive: presentation.activeSurface == .term,
                            terminalModel: presentation.terminal(client: appState.terminalClient)
                        )
                        .opacity(presentation.activeSurface == .term ? 1 : 0)
                        .allowsHitTesting(presentation.activeSurface == .term)
                        .accessibilityHidden(presentation.activeSurface != .term)
                        .transition(.move(edge: leftHandedDock ? .leading : .trailing))
                    }
                    if let surface = presentation.activeSurface, surface != .term {
                        WorkbenchHost(surface: surface)
                            .transition(.move(edge: leftHandedDock ? .leading : .trailing))
                    }
                }
                .toolbar(isBrowserFullScreen ? .hidden : .automatic, for: .navigationBar)
            }
            // Above the rail: the session cluster deliberately overlaps the
            // rail gutter, and must paint over it rather than beneath.
            .zIndex(1)
            if !leftHandedDock && !isBrowserFullScreen {
                dockRail
                    .zIndex(0)
            }
        }
        .overlay(alignment: leftHandedDock ? .topLeading : .topTrailing) {
            // Compact: the workbench overlays the conversation, so the
            // cluster goes with the rest of the chat toolbar.
            shellSessionCluster(suppressed: presentation.activeSurface != nil)
        }
    }

    /// The floating session cluster: shell chrome above the rail. It tracks
    /// the chat toolbar, so each branch passes its own `suppressed` rule, and
    /// full-screen browsing hides it in both.
    @ViewBuilder
    private func shellSessionCluster(suppressed: Bool) -> some View {
        if !isBrowserFullScreen, !suppressed, !fixtureMode {
            SessionControlsCluster(
                showSettings: $showSettings,
                showFrozenSessions: $showFrozenSessions,
                frozenOpen: appState.openFrozen != nil,
                leftHanded: leftHandedDock
            )
            .padding(.top, 4)
            .padding(.horizontal, 12)
        }
    }

    /// Regular width mirrors the dock and its workbench around a persistent
    /// conversation column. With no selected surface, conversation fills the
    /// space beside the rail. A foregrounded browser tab expands the same
    /// workbench to fill the window, keeping its stacked terminal alive.
    private var regularShell: some View {
        HStack(spacing: 0) {
            if leftHandedDock {
                if !isBrowserFullScreen {
                    dockRail
                }
                regularWorkbench
            }

            conversation
                .frame(maxWidth: isBrowserFullScreen ? 0 : .infinity)
                .toolbar(isBrowserFullScreen ? .hidden : .automatic, for: .navigationBar)
                .opacity(isBrowserFullScreen ? 0 : 1)
                .allowsHitTesting(!isBrowserFullScreen)
                .accessibilityHidden(isBrowserFullScreen)
                .clipped()

            if !leftHandedDock {
                regularWorkbench
                if !isBrowserFullScreen {
                    dockRail
                }
            }
        }
        .overlay(alignment: leftHandedDock ? .topLeading : .topTrailing) {
            // Regular split keeps the conversation beside the workbench, so
            // the cluster stays with it — same rule as the chat toolbar.
            shellSessionCluster(suppressed: false)
        }
    }

    private var conversation: some View {
        NavigationStack {
            if fixtureMode {
                FixtureConversationView(
                    transcriptPosition: $presentation.transcriptPosition)
            } else {
                ConversationView(
                    showSettings: $showSettings,
                    showFrozenSessions: $showFrozenSessions,
                    inputText: $presentation.composerDraft,
                    stagedAttachments: $presentation.stagedAttachments,
                    transcriptPosition: $presentation.transcriptPosition,
                    ptt: ptt
                )
                .environment(\.openURL, transcriptLinkAction)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var regularWorkbench: some View {
        if presentation.activeSurface != nil {
            if leftHandedDock {
                workbench
                if !isBrowserFullScreen {
                    Divider()
                }
            } else {
                if !isBrowserFullScreen {
                    Divider()
                }
                workbench
            }
        }
    }

    /// Stacked rather than switched, so moving between surfaces does not take
    /// the Ghostty view out of the window and destroy the terminal's
    /// scrollback (the compact shell keeps it for the same reason). Collapsing
    /// the column entirely still tears it down: an invisible full-width
    /// workbench cannot be expressed in a side-by-side layout.
    private var workbench: some View {
        ZStack {
            if presentation.terminalWasOpened || presentation.activeSurface == .term {
                WorkbenchHost(
                    surface: .term,
                    isActive: presentation.activeSurface == .term,
                    terminalModel: presentation.terminal(client: appState.terminalClient)
                )
                .opacity(presentation.activeSurface == .term ? 1 : 0)
                .allowsHitTesting(presentation.activeSurface == .term)
                .accessibilityHidden(presentation.activeSurface != .term)
            }
            if let surface = presentation.activeSurface, surface != .term {
                WorkbenchHost(surface: surface)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.move(edge: leftHandedDock ? .leading : .trailing))
    }

    private var dockRail: some View {
        DockRail(active: $presentation.activeSurface, sprinkles: appState.sprinkles)
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
                appState.settleConnectionImmediately()
                return
            }
            if raw == "streaming" {
                appState.connectionState = .connected
                appState.isStreaming = true
                appState.settleConnectionImmediately()
                return
            }
            guard let state = ConnectionState(rawValue: raw) else { return }
            appState.connectionState = state
            if state == .reconnecting {
                appState.reconnectAttempt = 3
            }
            // A pinned state is the test's premise, not a transition to be
            // held back: publish it before the first assertion looks.
            appState.settleConnectionImmediately()
        }

        /// Drop the pinned connection after a delay, optionally restoring it —
        /// the transition `ConnectionSettle` holds back, staged without a peer.
        /// The states are pinned rather than routed through `handleDisconnect`
        /// so the reconnect loop cannot dial the empty fixture Join URL.
        private func scheduleConnectionBlip() {
            guard let blip = UITestHooks.connectionBlip else { return }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(blip.dropAfter))
                appState.isLeaderStalled = false
                appState.reconnectAttempt = 1
                appState.connectionState = .reconnecting
                guard let healsAfter = blip.healsAfter else { return }
                try? await Task.sleep(for: .seconds(healsAfter))
                appState.reconnectAttempt = 0
                appState.connectionState = .connected
            }
        }
    #endif
}

// MARK: - ConversationView

/// The chat conversation column shown in the detail pane. Hosts the scoop
/// indicator, message list (with swipe gestures), and input bar.
struct ConversationView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette
    @Binding var showSettings: Bool
    @Binding var showFrozenSessions: Bool
    @Binding var inputText: String
    @Binding var stagedAttachments: [MessageAttachment]
    @Binding var transcriptPosition: ScrollPosition
    @ObservedObject var ptt: PttController
    /// True while a compact workbench overlay covers this conversation.
    /// The regular split never sets it: there the conversation stays
    /// visible beside the workbench and keeps its toolbar.
    var toolbarSuppressed: Bool = false
    @StateObject private var horizontalScrollGestureState = HorizontalScrollGestureState()
    /// Mirrors `ChatView` so the nav-bar clusters follow the rail to the
    /// reachable edge.
    @AppStorage("leftHandedDock") private var leftHandedDock = false

    var body: some View {
        VStack(spacing: 0) {
            if let frozen = appState.openFrozen {
                // Read-only view of an archived session. The live transcript
                // and composer are replaced wholesale — read-only means the
                // composer does not exist, not that it is merely grayed out.
                // A right swipe dismisses back to live, like the back gesture.
                MessageListView(
                    messages: frozen.archive.messages,
                    isStreaming: false,
                    toolUICards: [],
                    onInlineSprinkleLick: { _, _ in },
                    scrollPosition: $transcriptPosition
                )
                .transcriptSwipeGesture(
                    state: horizontalScrollGestureState,
                    onAction: handleTranscriptSwipe)
                FrozenSessionBanner()
            } else {
                liveConversation
            }
        }
        .environment(\.horizontalScrollGestureState, horizontalScrollGestureState)
        .environment(\.horizontalScrollAction, handleTranscriptSwipe)
        .background(palette.canvas)
        // The live session identifies itself through the compact switcher in
        // the corner, not through a nav title — two copies of the same scoop
        // label stacked on top of each other is what the full-width scoop
        // header used to cost.
        .navigationTitle(appState.openFrozen?.entry.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(appState.openFrozen != nil)
        .toolbar {
            if !toolbarSuppressed {
                identityGroup
            }
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
        if appState.openFrozen != nil {
            ToolbarItem(placement: identityPlacement) {
                Button {
                    appState.closeFrozenSession()
                } label: {
                    Image(systemName: "chevron.backward")
                        .foregroundStyle(palette.ink.opacity(0.7))
                }
                .accessibilityLabel("Back to live session")
                .accessibilityIdentifier("frozen-back")
            }
        } else if #available(iOS 26.0, *) {
            // Order: dropdown pill leads, the avatar sits alone at the
            // center, session controls trail — three separate items so
            // nothing can paint over anything else.
            ToolbarItem(placement: identityPlacement) {
                switcherPill
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .principal) {
                selectedAvatarView
            }
            .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: identityPlacement) {
                switcherPill
            }
            ToolbarItem(placement: .principal) {
                selectedAvatarView
            }
        }
    }

    /// One control height for the whole header row — pill, avatar, and
    /// cluster all measure 36pt like the cluster's buttons.
    private var switcherPill: some View {
        ScoopSwitcher()
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(.regularMaterial, in: Capsule())
    }

    private var selectedAvatarView: some View {
        sizedAvatar
    }

    private var sizedAvatar: some View {
        rawAvatarView
            .frame(width: 36, height: 36)
    }

    private var rawAvatarView: some View {
        ScoopStatusAvatar(
            avatar: selectedAvatar,
            accessibilityLabel: selectedAccessibilityLabel,
            expression: appState.avatarExpression
        )
    }

    private var selectedAvatar: SliccAgentAvatarGeometry {
        let eyesOverride: SliccAgentAvatarGeometry.EyeState? =
            showsConnectionStatic ? .static : nil
        return appState.selectedScoop?.avatarGeometry(
            sideLength: 30,
            eyesOverride: eyesOverride,
            activity: selectedActivity
        )
            ?? .init(
                type: .cone,
                color: "#D2691E",
                eyes: eyesOverride ?? .open,
                sideLength: 30,
                activity: selectedActivity)
    }

    /// The expression channel, derived from the mirrored lifecycle plus the two
    /// locally-observed signals the wire does not carry: whether a tool call is
    /// in flight, and whether the finished turn left the composer to you.
    /// The focused scoop gets the LOCAL derivation: this follower is already
    /// mirroring its tool bracket and its turn settle, which beats waiting for
    /// the leader's next `scoops.list`. Non-focused scoops read the wire.
    private var selectedActivity: AvatarExpression.Activity? {
        appState.selectedScoop?.avatarActivity(local: appState.localExpressionSignals)
            ?? (appState.awaitingUserSince != nil ? .awaiting : .idle)
    }

    private var selectedAccessibilityLabel: String {
        let lifecycleLabel =
            (appState.selectedScoop?.status ?? ScoopStatus(state: nil, fill: nil))
            .accessibilityPhrase(label: appState.selectedScoop?.assistantLabel ?? "Sliccy")
        guard let connectionStatusText else { return lifecycleLabel }
        return "\(lifecycleLabel). \(connectionStatusText)"
    }

    /// Both connection treatments read the SETTLED health, so a blip that heals
    /// inside the hold never flickers the eyes or rewrites the placeholder.
    private var showsConnectionStatic: Bool {
        !appState.settledConnection.isHealthy
    }

    private var connectionStatusText: String? {
        let health = appState.settledConnection
        if health.state == .connected, health.isStalled {
            return "The leader is busy — hang on…"
        }
        switch health.state {
        case .connected: return nil
        case .connecting: return "Connecting…"
        case .reconnecting:
            return health.reconnectAttempt > 0
                ? "Reconnecting… (\(health.reconnectAttempt)/\(ReconnectBackoff.maxAttempts))"
                : "Reconnecting…"
        case .disconnected: return "Disconnected"
        case .failed: return "Connection Failed"
        case .gaveUp: return "Couldn't reach the leader. Reload to retry."
        }
    }

    @ViewBuilder
    private var liveConversation: some View {
        Group {
            MessageListView(
                messages: appState.messages,
                isStreaming: appState.isStreaming,
                toolUICards: appState.toolUICards,
                openApprovals: appState.openApprovals,
                onOpenApprovalDecision: appState.resolveOpenApproval,
                sudoApprovals: appState.sudoApprovals,
                sudoAllowAlways: AppState.deviceOwnerAuthAvailable(),
                onSudoApprovalDecision: appState.resolveSudoApproval,
                onInlineSprinkleLick: { body, target in
                    appState.sendSprinkleLick("inline", body: body, targetScoop: target)
                },
                scrollPosition: $transcriptPosition
            )
            .transcriptSwipeGesture(
                state: horizontalScrollGestureState,
                onAction: handleTranscriptSwipe)

            InputBar(
                text: $inputText,
                isStreaming: appState.isStreaming,
                isConnected: appState.settledConnection.state == .connected,
                // A message typed during a stall would be accepted into the
                // composer and lost, so block sending — but say why, rather
                // than claiming the follower is disconnected.
                isStalled: appState.settledConnection.isStalled,
                steersActiveScoop: appState.composerTargetsLeaderActiveScoop,
                ptt: ptt,
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
                },
                stagedAttachments: $stagedAttachments
            )
        }
    }

    private func handleTranscriptSwipe(_ action: SwipeArbiter.Action) {
        if appState.openFrozen != nil {
            if action == .previous { appState.closeFrozenSession() }
            return
        }
        switch action {
        case .next:
            appState.swipeToNextScoop()
        case .previous:
            appState.swipeToPreviousScoop()
        case .none:
            break
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
    @Binding var transcriptPosition: ScrollPosition
    @State private var messages: [ChatMessage] = ChatFixture.makeMessages()
    @State private var lastLick: String?
    @State private var selectedFixtureScoop = 1
    @StateObject private var horizontalScrollGestureState = HorizontalScrollGestureState()
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
                    VStack(alignment: .leading, spacing: 1) {
                        Text("UI Fixture — synthetic session")
                            .font(.caption)
                            .foregroundStyle(palette.ink.opacity(0.7))
                            .accessibilityIdentifier("fixture-header")
                        Text("Fixture scoop \(selectedFixtureScoop)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.ink.opacity(0.55))
                            .accessibilityIdentifier("fixture-scoop-selection")
                            .accessibilityValue(horizontalScrollGestureState.swipeDiagnostic)
                    }
                }
                Spacer()
                Button("Reload") {
                    messages = ChatFixture.makeMessages()
                    lastLick = nil
                    selectedFixtureScoop = 1
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
                },
                scrollPosition: $transcriptPosition
            )
            .transcriptSwipeGesture(
                state: horizontalScrollGestureState,
                onAction: handleFixtureSwipe)
        }
        .environment(\.horizontalScrollGestureState, horizontalScrollGestureState)
        .environment(\.horizontalScrollAction, handleFixtureSwipe)
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

    private func handleFixtureSwipe(_ action: SwipeArbiter.Action) {
        switch action {
        case .next:
            selectedFixtureScoop = min(selectedFixtureScoop + 1, 3)
        case .previous:
            selectedFixtureScoop = max(selectedFixtureScoop - 1, 1)
        case .none:
            break
        }
    }
}

extension View {
    @ViewBuilder
    fileprivate func transcriptSwipeGesture(
        state: HorizontalScrollGestureState,
        onAction: @escaping (SwipeArbiter.Action) -> Void
    ) -> some View {
        coordinateSpace(name: state.coordinateSpaceName)
            .simultaneousGesture(
                arbitratedScoopSwipeGesture(state: state, onAction: onAction))
    }
}

/// Parent observer for ordinary transcript content. On iOS 18+, guarded
/// descendants resolve their own handoff through UIKit's delegate.
private func arbitratedScoopSwipeGesture(
    state: HorizontalScrollGestureState,
    onAction: @escaping (SwipeArbiter.Action) -> Void
) -> some Gesture {
    DragGesture(
        minimumDistance: SwipeArbiter.gestureMinimumDistance,
        coordinateSpace: .named(state.coordinateSpaceName)
    )
    .onChanged { value in
        state.beginOuterGesture(at: value.startLocation)
    }
    .onEnded { value in
        let origin = state.endOuterGesture()
        if #available(iOS 18.0, *) {
            onAction(SwipeArbiter.outerAction(for: value.translation, origin: origin))
        } else {
            onAction(SwipeArbiter.action(for: value.translation, origin: origin))
        }
    }
}

// MARK: - ScoopSwitcher

/// The nav-bar cone/scoop switcher. Replaces the old full-width header row:
/// the same identity (label + leader-active dot) in a nav-bar-sized
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
                        Label(
                            menuTitle(for: scoop),
                            systemImage: scoop.jid == appState.selectedScoopJid
                                ? "checkmark" : "circle")
                    }
                    .accessibilityLabel(menuTitle(for: scoop))
                    .accessibilityIdentifier("scoop-switch-\(scoop.jid)")
                }
            } label: {
                identityLabel
            }
            .accessibilityLabel(appState.selectedScoop?.assistantLabel ?? "Sliccy")
            .accessibilityHint("Switch scoop")
            .accessibilityIdentifier("scoop-switcher")
        } else {
            identityLabel
                .accessibilityLabel(appState.selectedScoop?.assistantLabel ?? "Sliccy")
                .accessibilityIdentifier("scoop-switcher")
        }
    }

    /// The dropdown's face: label + chevron only. The bound lives INSIDE
    /// the label because a Menu never compresses its label view — an outer
    /// frame makes long text overflow the pill instead of truncating.
    /// Leader-active is spoken in the menu rows, not as a dot here.
    private var identityLabel: some View {
        HStack(spacing: 5) {
            Text(appState.selectedScoop?.assistantLabel ?? "Sliccy")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(palette.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 120, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if appState.scoops.count > 1 {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(palette.ink.opacity(0.5))
            }
        }
    }

    /// The leader's active scoop is marked in the menu too — the dot on the
    /// closed control only speaks about the one you are looking at. State and
    /// fullness stay textual because native Menu rows cannot host the avatar.
    private func menuTitle(for scoop: ScoopSummary) -> String {
        let kind = scoop.isCone ? "cone" : "scoop"
        let status = scoop.status.accessibilityPhrase(label: scoop.assistantLabel)
        return scoop.jid == appState.leaderActiveScoopJid
            ? "\(status) · \(kind) · active"
            : "\(status) · \(kind)"
    }
}

// MARK: - SessionControlsCluster

/// The session cluster as shell chrome, not toolbar content: the
/// navigation bar clips its items at the column edge, and this cluster
/// deliberately overlaps the dock rail — so it floats in the shell's
/// coordinate space above the rail instead.
struct SessionControlsCluster: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette
    @Binding var showSettings: Bool
    @Binding var showFrozenSessions: Bool
    let frozenOpen: Bool
    let leftHanded: Bool
    @State private var showNewSessionDialog = false

    var body: some View {
        HStack(spacing: 0) {
            if frozenOpen {
                settingsButton
                    .frame(width: 36, height: 36)
            } else if leftHanded {
                newChatButton
                    .frame(width: 36, height: 36)
                settingsButton
                    .frame(width: 36, height: 36)
                frozenSessionsButton
                    .frame(width: 36, height: 36)
            } else {
                frozenSessionsButton
                    .frame(width: 36, height: 36)
                settingsButton
                    .frame(width: 36, height: 36)
                newChatButton
                    .frame(width: 36, height: 36)
            }
        }
        .background(.regularMaterial, in: Capsule())
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
        // RAW health, unlike the composer: `requestNewSession` returns without
        // a word when the channel cannot be written, so a button left live
        // through the settle window would answer a tap with nothing at all. A
        // send in that window is not silent — it lands in the transcript and
        // marks itself undelivered — which is why that one follows the settled
        // view and this one does not.
        .disabled(
            appState.newSessionInFlight
                || !appState.rawConnectionHealth.isHealthy
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
}

/// The selected avatar sits beside the switcher. Fullness is already encoded in
/// its pupil size; lifecycle and the exact fill remain available to VoiceOver.
private struct ScoopStatusAvatar: View {
    let avatar: SliccAgentAvatarGeometry
    let accessibilityLabel: String
    var expression: AvatarExpressionEngine?

    var body: some View {
        ZStack {
            SliccAgentAvatarView(avatar: avatar, expression: expression)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("scoop-avatar")
    }
}

// MARK: - Preview

#Preview {
    ChatView()
        .preferredColorScheme(.dark)
        .environmentObject(AppState())
        .environmentObject(InboundActionCoordinator())
}
