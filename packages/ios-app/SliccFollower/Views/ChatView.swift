import SliccTrayKit
import SwiftUI
import UIKit
import os





struct ChatView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var inboundActions: InboundActionCoordinator
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.openURL) var openURL
    @StateObject private var presentation: ChatPresentationState
    @StateObject private var ptt = PttController(
        engine: InputBar.makeDictationEngine(),
        prepareForRecording: { VoiceReply.shared.stopSpeaking() })
    
    
    
    @StateObject var transcriptActions = TranscriptActionModel()
    
    
    @StateObject private var threadList = ThreadListModel()
    
    @StateObject private var threadSummaries = ThreadSummaryStore()
    @State private var showSettings = false
    @State private var hasAppeared = false
    
    @State private var fixtureMode = false
    
    
    @State private var showFrozenSessions = false
    
    
    @AppStorage("leftHandedDock") private var leftHandedDock = false
    
    @AppStorage("inboundAlwaysOpenHosts") private var alwaysOpenHosts = ""
    
    
    @AppStorage("inboundAlwaysAllowPrompts") private var alwaysAllowPrompts = false
    
    
    
    @AppStorage("openLinksInBuiltInBrowser") var openLinksInBuiltInBrowser = true

    init() {
        _presentation = StateObject(
            wrappedValue: ChatPresentationState(composerDraft: Self.seededComposerText()))
    }

    
    
    init(presentation: @autoclosure @escaping () -> ChatPresentationState) {
        _presentation = StateObject(wrappedValue: presentation())
    }

    var body: some View {
        GeometryReader { geometry in
            let mode = ShellLayout.mode(
                horizontalSizeClass: horizontalSizeClass,
                availableWidth: geometry.size.width)
            let threadListPresentation = ThreadListLayout.presentation(
                shellMode: mode, availableWidth: geometry.size.width,
                workbenchOpen: presentation.activeSurface != nil)
            Group {
                switch mode {
                case .compactOverlay:
                    compactShell
                case .regularSplit:
                    regularShell(threadListPresentation: threadListPresentation)
                }
            }
            .overlay {
                if threadListPresentation == .overlay, showsThreadList {
                    ThreadListOverlay(
                        edge: threadListEdge, availableWidth: geometry.size.width)
                }
            }
            .environment(\.threadListPresentation, threadListPresentation)
            .onChange(of: threadListPresentation) { _, shape in
                threadList.presentationChanged(to: shape)
            }
        }
        .environmentObject(threadList)
        .environmentObject(threadSummaries)
        .onReceive(appState.$scoops.combineLatest(appState.$selectedScoopJid)) { scoops, selected in
            threadList.sync(scoops: scoops, selectedJid: selected)
        }
        
        
        
        
        
        .transcriptActionSheets(transcriptActions)
        
        
        .preferredColorScheme(appState.leaderTheme.map { $0.base == .light ? .light : .dark })
        .environment(
            \.palette,
            ThemePalette.resolve(theme: appState.leaderTheme, systemScheme: systemScheme)
        )
        .environment(\.sprinkleThemeCSS, appState.leaderTheme?.sprinkleCSSOverrides ?? "")
        
        
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
                
                
                if let surface = UITestHooks.opensDockSurface() {
                    presentation.activeSurface = surface
                    presentation.terminalWasOpened = surface == .term
                }
                if let targets = UITestHooks.remoteTargetsFixture() {
                    appState.remoteTargets = targets
                }
                if let computers = UITestHooks.computersFixture() {
                    appState.computers = computers
                    for computer in computers {
                        if let image = UITestHooks.computerPreviewFixtureImage() {
                            appState.liveFrame(forComputerId: computer.id).apply(
                                image: image, seq: 1, width: 480, height: 270)
                        }
                    }
                    if UserDefaults.standard.bool(forKey: "uiTestComputerLive") {
                        appState.viewingComputerId = computers.first?.id
                    }
                }
                if let inboundURL = UITestHooks.inboundOpenURL {
                    _ = inboundActions.receive(url: inboundURL, needsConfirmation: true)
                }
                
                
                scheduleConnectionBlip()
                UITestHooks.scheduleThreadListTurns(into: appState)
                if UITestHooks.opensThreadList { threadList.isOverlayOpen = true }
                if UITestHooks.scriptCompletedTurn(into: appState) {
                    return
                }
                if let forced = UITestHooks.forcedConnectionState {
                    applyForcedConnectionState(forced)
                    
                    
                    
                    UITestHooks.seedTranscriptFixture(into: appState)
                    UITestHooks.seedShortActionsFixture(into: appState)
                    UITestHooks.scheduleTranscriptAppend(into: appState)
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
        .onChange(of: inboundActions.pendingSelection) { selection in
            if let selection {
                executeInboundSelection(selection)
            }
        }
        
        
        
        .onChange(of: appState.scoops) { _ in
            if let selection = inboundActions.pendingSelection {
                executeInboundSelection(selection)
            }
        }
    }

    
    
    
    
    
    
    private func executeInboundSelection(
        _ selection: InboundActionCoordinator.PendingSelection
    ) {
        switch InboundSelectionRule.outcome(
            forSelecting: selection.scoopJid,
            roster: appState.scoops.map(\.jid),
            age: Date().timeIntervalSince(selection.receivedAt))
        {
        case .wait:
            
            return
        case .drop:
            inboundActions.consume(selection: selection)
        case .select:
            appState.selectScoop(jid: selection.scoopJid)
            
            withAnimation { presentation.activeSurface = nil }
            inboundActions.consume(selection: selection)
        }
    }

    
    
    
    
    private func presentLeaderOpenedTab(_ tabId: String?) {
        guard let tabId else { return }
        withAnimation {
            presentation.activeSurface = .browser
        }
        appState.browserViewingTabId = tabId
        
        
        appState.leaderOpenedTabId = nil
    }

    

    
    
    private func executeInboundOpen(_ action: InboundActionCoordinator.PendingOpen) {
        inboundActions.consume(action)
        openInBuiltInBrowser(action.url)
    }

    func openInBuiltInBrowser(_ url: URL) {
        withAnimation {
            presentation.activeSurface = .browser
        }
        let id = appState.cdpOpenTab(url: url.absoluteString)
        appState.browserViewingTabId = id
    }

    
    
    
    
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

    
    
    static func boundedCallbackResult(_ text: String) -> String {
        text.count <= 2000 ? text : String(text.prefix(2000)) + "…"
    }

    
    
    
    private var isBrowserFullScreen: Bool {
        presentation.activeSurface == .browser
            && (appState.browserViewingTabId != nil || appState.viewingComputerId != nil)
    }

    
    
    private var compactShell: some View {
        
        
        
        
        HStack(spacing: 0) {
            if leftHandedDock && !isBrowserFullScreen {
                dockRail
            }
            NavigationStack {
                ZStack {
                    if fixtureMode {
                        FixtureConversationView()
                    } else {
                        ConversationView(
                            showSettings: $showSettings,
                            showFrozenSessions: $showFrozenSessions,
                            inputText: $presentation.composerDraft,
                            stagedAttachments: $presentation.stagedAttachments,
                            ptt: ptt,
                            
                            
                            
                            
                            
                            toolbarSuppressed: presentation.activeSurface != nil
                        )
                        .environment(\.openURL, transcriptLinkAction)
                        .environment(\.transcriptActions, transcriptActionHandlers)
                        .environment(\.fileMentionResolver, appState.fileMentionResolver)
                    }
                    
                    
                    
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
            
            
            .zIndex(1)
            if !leftHandedDock && !isBrowserFullScreen {
                dockRail
                    .zIndex(0)
            }
        }
        .overlay(alignment: leftHandedDock ? .topLeading : .topTrailing) {
            
            
            shellSessionCluster(suppressed: presentation.activeSurface != nil)
        }
    }

    
    
    
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

    
    
    
    
    private func regularShell(threadListPresentation: ThreadListPresentation) -> some View {
        HStack(spacing: 0) {
            if leftHandedDock {
                if !isBrowserFullScreen {
                    dockRail
                }
                regularWorkbench
            }

            if !leftHandedDock, showsThreadSidebar(threadListPresentation) {
                ThreadListSidebar(edge: .leading)
            }
            conversation
                .frame(maxWidth: isBrowserFullScreen ? 0 : .infinity)
                .toolbar(isBrowserFullScreen ? .hidden : .automatic, for: .navigationBar)
                .opacity(isBrowserFullScreen ? 0 : 1)
                .allowsHitTesting(!isBrowserFullScreen)
                .accessibilityHidden(isBrowserFullScreen)
                .clipped()

            if leftHandedDock, showsThreadSidebar(threadListPresentation) {
                ThreadListSidebar(edge: .trailing)
            }

            if !leftHandedDock {
                regularWorkbench
                if !isBrowserFullScreen {
                    dockRail
                }
            }
        }
        .overlay(alignment: leftHandedDock ? .topLeading : .topTrailing) {
            
            
            shellSessionCluster(suppressed: false)
        }
    }

    private var conversation: some View {
        NavigationStack {
            if fixtureMode {
                FixtureConversationView()
            } else {
                ConversationView(
                    showSettings: $showSettings,
                    showFrozenSessions: $showFrozenSessions,
                    inputText: $presentation.composerDraft,
                    stagedAttachments: $presentation.stagedAttachments,
                    ptt: ptt
                )
                .environment(\.openURL, transcriptLinkAction)
                .environment(\.transcriptActions, transcriptActionHandlers)
                .environment(\.fileMentionResolver, appState.fileMentionResolver)
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

    
    
    private var threadListEdge: HorizontalEdge {
        leftHandedDock ? .trailing : .leading
    }

    
    
    
    private var showsThreadList: Bool {
        appState.scoops.count > 1 && appState.openFrozen == nil && !isBrowserFullScreen
            && !fixtureMode
    }

    private func showsThreadSidebar(_ shape: ThreadListPresentation) -> Bool {
        shape == .sidebar && showsThreadList && !threadList.isSidebarCollapsed
    }

    private var dockRail: some View {
        DockRail(active: $presentation.activeSurface, sprinkles: appState.sprinkles)
    }

    
    
    
    static func seededComposerText() -> String {
        #if DEBUG
            return UserDefaults.standard.string(forKey: "uiTestComposerText") ?? ""
        #else
            return ""
        #endif
    }

    #if DEBUG
        
        
        
        
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
            
            
            appState.settleConnectionImmediately()
        }

        
        
        
        
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





struct ConversationView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.palette) private var palette
    @Binding var showSettings: Bool
    @Binding var showFrozenSessions: Bool
    @Binding var inputText: String
    @Binding var stagedAttachments: [MessageAttachment]
    @ObservedObject var ptt: PttController
    
    
    
    var toolbarSuppressed: Bool = false
    @StateObject private var horizontalScrollGestureState = HorizontalScrollGestureState()
    
    
    @AppStorage("leftHandedDock") private var leftHandedDock = false

    var body: some View {
        VStack(spacing: 0) {
            if let frozen = appState.openFrozen {
                
                
                
                
                MessageListView(
                    messages: frozen.archive.messages,
                    isStreaming: false,
                    toolUICards: [],
                    onInlineSprinkleLick: { _, _ in }
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
        
        
        
        
        .navigationTitle(appState.openFrozen?.entry.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(appState.openFrozen != nil)
        
        .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
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

    

    
    
    private var identityPlacement: ToolbarItemPlacement {
        leftHandedDock ? .topBarTrailing : .topBarLeading
    }
    private var controlsPlacement: ToolbarItemPlacement {
        leftHandedDock ? .topBarLeading : .topBarTrailing
    }

    
    
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

    
    
    private var switcherPill: some View {
        ScoopSwitcher()
            .padding(.horizontal, 12)
            .frame(height: 36)
            .floatingGlass(in: Capsule(), interactive: true)
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

    
    
    
    
    
    
    
    private var liveConversation: some View {
        MessageListView(
            messages: appState.messages,
            isStreaming: appState.isStreaming,
            toolProgress: appState.toolProgress,
            toolUICards: appState.visibleToolUICards,
            openApprovals: appState.openApprovals,
            onOpenApprovalDecision: appState.resolveOpenApproval,
            sudoApprovals: appState.sudoApprovals,
            sudoAllowAlways: AppState.deviceOwnerAuthAvailable(),
            onSudoApprovalDecision: appState.resolveSudoApproval,
            onInlineSprinkleLick: { body, target in
                appState.sendSprinkleLick("inline", body: body, targetScoop: target)
            }
        )
        
        
        
        
        
        
        
        .id(appState.selectedScoopJid)
        .transcriptSwipeGesture(
            state: horizontalScrollGestureState,
            onAction: handleTranscriptSwipe
        )
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    }

    
    
    
    
    
    @ViewBuilder
    private var composer: some View {
        if !appState.selectedUnitIsReadOnly {
            InputBar(
                text: $inputText,
                isStreaming: appState.isStreaming,
                isConnected: appState.settledConnection.state == .connected,
                
                
                
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







struct FixtureConversationView: View {
    @Environment(\.palette) private var palette
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
                toolProgress: ChatFixture.toolProgress,
                toolUICards: [
                    ToolUIPlaceholder(requestId: "fx-tool-ui-1", html: ChatFixture.toolUIHtml)
                ],
                onInlineSprinkleLick: { body, target in
                    let summary = describeLick(body: body, target: target)
                    Self.log.info("sprinkle lick: \(summary)")
                    lastLick = summary
                }
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
        .floatingGlass(in: Capsule())
    }

    private var newChatButton: some View {
        Button {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder),
                to: nil, from: nil, for: nil)
            showNewSessionDialog = true
        } label: {
            Group {
                if appState.newSessionInFlight {
                    ProgressView()
                } else {
                    Image(systemName: "square.and.pencil")
                        .foregroundStyle(palette.ink.opacity(0.7))
                }
            }
            .sessionControlHitArea()
        }
        
        
        
        
        
        
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
                .sessionControlHitArea()
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
                .sessionControlHitArea()
        }
        .accessibilityLabel("Past Sessions")
        .accessibilityIdentifier("frozen-rail-button")
    }
}

extension View {
    
    
    
    
    
    fileprivate func sessionControlHitArea() -> some View {
        frame(width: 36, height: 36).contentShape(Rectangle())
    }
}



#Preview {
    ChatView()
        .preferredColorScheme(.dark)
        .environmentObject(AppState())
        .environmentObject(InboundActionCoordinator())
}
