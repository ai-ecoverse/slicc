import AppUpdater
import SliccTraySession
import SwiftUI
import UniformTypeIdentifiers

struct AppListView: View {
    let targets: [AppTarget]
    @Bindable var sliccProcess: SliccProcess
    let sessionStore: TraySessionSyncStore
    @Bindable var appManagementPermission: AppManagementPermission
    @ObservedObject var appUpdater: AppUpdater
    let updateCheckStatus: UpdateCheckStatus
    let hasRecentAgentActivity: Bool
    let onCheckForUpdates: () -> Void
    let onLaunchStandalone: (AppTarget) -> Void
    let onLaunchBrowserFollower: (AppTarget, String) -> Void
    let onLaunchElectron: (AppTarget) -> Void
    let onCreateDebugBuild: (AppTarget) -> Void
    let onUpdate: () -> Void
    let onBeginUpdate: () -> Void
    let onRescan: () -> Void

    @AppStorage(suppressTerminalWarningKey) private var suppressTerminalWarning = false
    @State private var pendingTerminalTarget: AppTarget?
    @State private var pendingJoinURLOverride: String?
    @State private var showTerminalWarning = false
    @State private var suppressWarningAfterApproval = false
    @State private var showTerminalDownloadPrompt = false
    @State private var terminalLaunchError: String?
    @State private var browserOrder: [String] = []
    @State private var terminalOrder: [String] = []
    @State private var draggingBundleId: String?
    @State private var browserDialogTarget: AppTarget?
    @State private var sessionReachability = SessionReachability()

    private let orderStore = AppOrderStore()

    private var orderedBrowsers: [AppTarget] {
        AppOrdering.ordered(
            targets.filter { $0.type == .chromiumBrowser },
            savedOrder: browserOrder,
            defaultPriority: AppOrdering.browserBundlePriority
        )
    }

    private var orderedTerminals: [AppTarget] {
        AppOrdering.ordered(
            targets.filter { $0.type == .terminal },
            savedOrder: terminalOrder,
            defaultPriority: AppOrdering.terminalBundlePriority
        )
    }

    private var electronApps: [AppTarget] {
        targets.filter { $0.type == .electronApp }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(AppListSection.visibleSections(for: targets), id: \.self) { section in
                sectionContent(section)
            }

            sessionsSection

            Spacer(minLength: 0)

            Divider()
            HStack {
                updateButton
                if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                    Text("v\(version)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Button("Rescan") { onRescan() }
                    .buttonStyle(.borderless).font(.caption)
                    .accessibilityIdentifier("rescan")
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
        .onAppear {
            browserOrder = orderStore.load(AppOrderStore.browserKey)
            terminalOrder = orderStore.load(AppOrderStore.terminalKey)
        }
        .alert("Allow terminal access?", isPresented: $showTerminalWarning) {
            Toggle("Don't show this again", isOn: $suppressWarningAfterApproval)
            Button("Cancel", role: .cancel) { clearPendingTerminalLaunch() }
            Button("Continue") { approveTerminalWarning() }
        } message: {
            Text("SLICC will be able to run shell commands on this machine through the terminal follower.")
        }
        .alert("Download the slicc CLI?", isPresented: $showTerminalDownloadPrompt) {
            Button("Cancel", role: .cancel) { clearPendingTerminalLaunch() }
            Button("Download and Open") { launchPendingTerminal() }
        } message: {
            Text("The slicc command is required to attach this terminal. Download it from sliccy.ai and install it in Application Support?")
        }
        .alert(
            "Could not open terminal",
            isPresented: Binding(
                get: { terminalLaunchError != nil },
                set: { if !$0 { terminalLaunchError = nil } }
            )
        ) {
            Button("OK") { terminalLaunchError = nil }
        } message: {
            Text(terminalLaunchError ?? "")
        }
        .confirmationDialog(
            browserDialogTarget.map { "Launch \($0.name)" } ?? "Launch browser",
            isPresented: Binding(
                get: { browserDialogTarget != nil },
                set: { if !$0 { browserDialogTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: browserDialogTarget
        ) { target in
            Button("Launch standalone") {
                onLaunchStandalone(target)
                browserDialogTarget = nil
            }
            ForEach(attachableRemoteSessions) { session in
                Button("Attach to \(session.label) on \(session.deviceName)") {
                    onLaunchBrowserFollower(target, session.joinUrl)
                    browserDialogTarget = nil
                }
            }
            Button("Cancel", role: .cancel) { browserDialogTarget = nil }
        } message: { target in
            Text("Launch \(target.name) as its own session, or attach it to a running iCloud session as a follower.")
        }
    }

    @ViewBuilder
    private func sectionContent(_ section: AppListSection) -> some View {
        switch section {
        case .browsers:
            browsersSection
        case .desktopApps:
            desktopAppsSection
        case .terminals:
            terminalsSection
        case .browserExtension:
            extensionSection
        }
    }

    @ViewBuilder
    private var browsersSection: some View {
        SectionHeader("Browsers")
        ForEach(orderedBrowsers) { target in
            AppRow(
                target: target,
                runtimeState: sliccProcess.runtimeState(for: target),
                onLaunch: { handleBrowserLaunch(target) },
                onCreateDebugBuild: nil
            )
            .modifier(
                ReorderableRow(
                    target: target,
                    order: $browserOrder,
                    displayed: orderedBrowsers,
                    dragging: $draggingBundleId,
                    onCommit: { orderStore.save($0, forKey: AppOrderStore.browserKey) }
                )
            )
        }
    }

    @ViewBuilder
    private var desktopAppsSection: some View {
        SectionHeader("Desktop Apps")
        ForEach(electronApps) { target in
            let runtimeState = sliccProcess.runtimeState(
                for: target,
                hasAppManagementPermission: appManagementPermission.isGranted
            )
            AppRow(
                target: target,
                runtimeState: runtimeState,
                onLaunch: { handleElectronRow(target, runtimeState: runtimeState) },
                onCreateDebugBuild: target.debugSupport == .disabled ? { onCreateDebugBuild(target) } : nil
            )
        }
    }

    @ViewBuilder
    private var terminalsSection: some View {
        SectionHeader("Terminals")
        ForEach(orderedTerminals) { target in
            let runtimeState = sliccProcess.runtimeState(for: target)
            AppRow(
                target: target,
                runtimeState: runtimeState,
                onLaunch: { beginTerminalLaunch(target) },
                onCreateDebugBuild: nil,
                subtitleOverride: terminalSubtitle(runtimeState: runtimeState),
                interactionDisabled: sliccProcess.isLaunchingTerminalFollower
            )
            .modifier(
                ReorderableRow(
                    target: target,
                    order: $terminalOrder,
                    displayed: orderedTerminals,
                    dragging: $draggingBundleId,
                    onCommit: { orderStore.save($0, forKey: AppOrderStore.terminalKey) }
                )
            )
        }
    }

    @ViewBuilder
    private var extensionSection: some View {
        SectionHeader("Extension")
        Button {
            sliccProcess.openChromeWebStore()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "puzzlepiece.extension")
                    .font(.system(size: 15))
                    .frame(width: 28, height: 28)
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Get Extension").font(.system(size: 13))
                    Text("Install from Chrome Web Store")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("get-extension")
        .accessibilityLabel("Get Extension")
    }

    @ViewBuilder
    private var sessionsSection: some View {
        let remote = TraySessionPresentation.sortedRemoteSessions(
            sessionStore.remoteSessions,
            verdicts: sessionReachability.verdicts
        )
        let local = sessionStore.localSessions
        if !remote.isEmpty || !local.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                SectionHeader("iCloud Sessions")
                ForEach(remote) { session in
                    TraySessionRow(
                        session: session,
                        isLocal: false,
                        localBrowserIcon: localBrowserIcon(for: session),
                        verdict: sessionReachability.verdicts[session.id],
                        canAttachBrowser: orderedBrowsers.first != nil,
                        canFollow: !orderedTerminals.isEmpty,
                        onCopy: { copyJoinURL(session) },
                        onAttachBrowser: { attachBrowser(to: session) },
                        onFollow: { beginRemoteFollow(session) }
                    )
                }
                ForEach(local) { session in
                    TraySessionRow(
                        session: session,
                        isLocal: true,
                        localBrowserIcon: localBrowserIcon(for: session),
                        verdict: nil,
                        canAttachBrowser: false,
                        canFollow: false,
                        onCopy: { copyJoinURL(session) },
                        onAttachBrowser: {},
                        onFollow: {}
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onAppear { sessionReachability.probe(sessionStore.remoteSessions) }
            .onChange(of: sessionStore.remoteSessions) { _, sessions in
                sessionReachability.probe(sessions)
            }
        }
    }

    private func localBrowserIcon(for session: SyncedTraySession) -> NSImage? {
        orderedBrowsers.first(where: { $0.name == session.label })?.icon
    }

    private var attachableRemoteSessions: [SyncedTraySession] {
        TraySessionPresentation.attachableSessions(
            sessionStore.remoteSessions,
            verdicts: sessionReachability.verdicts
        )
    }

    private func handleBrowserLaunch(_ target: AppTarget) {
        // Re-probe so a leader that died after the last section-appear probe
        // drops out of the dialog while it is open; the resolve below still
        // uses the verdicts already in hand.
        sessionReachability.probe(sessionStore.remoteSessions)
        switch BrowserLaunchAction.resolve(
            isRunning: sliccProcess.runtimeState(for: target).isRunning,
            hasAttachableSessions: !attachableRemoteSessions.isEmpty
        ) {
        case .standalone:
            onLaunchStandalone(target)
        case .chooseLeadOrAttach:
            browserDialogTarget = target
        }
    }

    private func attachBrowser(to session: SyncedTraySession) {
        guard let top = orderedBrowsers.first else { return }
        onLaunchBrowserFollower(top, session.joinUrl)
    }

    private func copyJoinURL(_ session: SyncedTraySession) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(session.joinUrl, forType: .string)
    }

    private func beginRemoteFollow(_ session: SyncedTraySession) {
        guard let terminal = orderedTerminals.first else {
            terminalLaunchError = "Install a supported terminal to follow this session."
            return
        }
        pendingJoinURLOverride = session.joinUrl
        beginTerminalLaunch(terminal)
    }

    private func handleElectronRow(_ target: AppTarget, runtimeState: AppRuntimeState) {
        if runtimeState == .cannotStart(.needsDebugBuild) {
            onCreateDebugBuild(target)
        } else if runtimeState == .cannotStart(.needsPermission) {
            appManagementPermission.openSystemSettings()
        } else if runtimeState != .cannotStart(.needsLeader) {
            onLaunchElectron(target)
        }
    }

    private func terminalSubtitle(runtimeState: AppRuntimeState) -> String? {
        if sliccProcess.isLaunchingTerminalFollower {
            return sliccProcess.terminalCliDownloadProgress?.statusText ?? "Opening terminal…"
        }
        if runtimeState == .cannotStart(.needsLeader) {
            return "Start a browser session first"
        }
        return nil
    }

    private func beginTerminalLaunch(_ target: AppTarget, warningAcknowledged: Bool = false) {
        // A remote (iCloud) session supplies its own join URL, so the local
        // leader-readiness gate does not apply when an override is pending.
        let leaderReady = sliccProcess.isLeaderReady() || pendingJoinURLOverride != nil
        let nextStep = TerminalLaunchDecision.nextStep(
            leaderReady: leaderReady,
            warningSuppressed: suppressTerminalWarning,
            warningAcknowledged: warningAcknowledged,
            cliAvailable: sliccProcess.isTerminalCliAvailable()
        )
        pendingTerminalTarget = target
        switch nextStep {
        case .blockedByMissingLeader:
            clearPendingTerminalLaunch()
        case .showWarning:
            suppressWarningAfterApproval = false
            showTerminalWarning = true
        case .confirmDownload:
            showTerminalDownloadPrompt = true
        case .launch:
            launchPendingTerminal()
        }
    }

    private func approveTerminalWarning() {
        suppressTerminalWarning = suppressWarningAfterApproval
        guard let target = pendingTerminalTarget else { return }
        beginTerminalLaunch(target, warningAcknowledged: true)
    }

    private func launchPendingTerminal() {
        guard let target = pendingTerminalTarget else { return }
        let override = pendingJoinURLOverride
        Task { @MainActor in
            do {
                try await sliccProcess.launchTerminalFollower(target, joinURLOverride: override)
                clearPendingTerminalLaunch()
            } catch {
                LauncherErrorReport.report(.terminalFollower, error)
                terminalLaunchError = "\(error.localizedDescription) Try again, or install the slicc CLI manually."
                clearPendingTerminalLaunch(keepError: true)
            }
        }
    }

    private func clearPendingTerminalLaunch(keepError: Bool = false) {
        pendingTerminalTarget = nil
        pendingJoinURLOverride = nil
        suppressWarningAfterApproval = false
        if !keepError { terminalLaunchError = nil }
    }

    @ViewBuilder
    private var updateButton: some View {
        if SliccBootstrapper.isBundled {
            fullUpdateButton
        } else {
            Button("Update") { onUpdate() }
                .buttonStyle(.borderless).font(.caption)
                .accessibilityIdentifier("update")
        }
    }

    @ViewBuilder
    private var fullUpdateButton: some View {
        if let bundle = downloadedUpdateBundle {
            if let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String, !version.isEmpty {
                Button("Restart to Update to v\(version)") {
                    onBeginUpdate()
                    appUpdater.install(bundle)
                }
                .buttonStyle(.borderless).font(.caption)
                .foregroundStyle(fullUpdateTint)
                .accessibilityIdentifier("restart-to-update")
            } else {
                Button("Restart to Update") {
                    onBeginUpdate()
                    appUpdater.install(bundle)
                }
                .buttonStyle(.borderless).font(.caption)
                .foregroundStyle(fullUpdateTint)
                .accessibilityIdentifier("restart-to-update")
            }
        } else {
            checkForUpdatesButton
        }
    }

    @ViewBuilder
    private var checkForUpdatesButton: some View {
        Button(updateCheckStatus.buttonTitle) { onCheckForUpdates() }
            .buttonStyle(.borderless).font(.caption)
            .disabled(!updateCheckStatus.allowsRetry)
            .foregroundStyle(updateCheckStatusTint)
            .help(updateCheckStatus.detail ?? "")
            .accessibilityIdentifier("check-for-updates")
    }

    private var updateCheckStatusTint: AnyShapeStyle {
        switch updateCheckStatus {
        case .idle:
            return AnyShapeStyle(.primary)
        case .checking, .upToDate:
            return AnyShapeStyle(.secondary)
        case .noInstallableRelease, .translocated:
            return AnyShapeStyle(Color.orange)
        case .failed:
            return AnyShapeStyle(Color.red)
        }
    }

    private var fullUpdateTint: AnyShapeStyle {
        hasRecentAgentActivity ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.green)
    }

    private var downloadedUpdateBundle: Bundle? {
        if case .downloaded(_, _, let bundle) = appUpdater.state { return bundle }
        return nil
    }
}

struct TraySessionRow: View {
    let session: SyncedTraySession
    let isLocal: Bool
    let localBrowserIcon: NSImage?
    let verdict: SessionReachability.Verdict?
    let canAttachBrowser: Bool
    let canFollow: Bool
    let onCopy: () -> Void
    let onAttachBrowser: () -> Void
    let onFollow: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            icon
            VStack(alignment: .leading, spacing: 1) {
                Text(session.label).font(.system(size: 13))
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(action: onCopy) {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .help("Copy join URL")
            .accessibilityIdentifier("session-copy-\(session.id)")
            if !isLocal {
                Button(action: onAttachBrowser) {
                    Image(systemName: "globe")
                }
                .buttonStyle(.borderless)
                .disabled(!attachBrowserEnabled)
                .help(attachBrowserHelp)
                .accessibilityIdentifier("session-attach-browser-\(session.id)")
                Button(action: onFollow) {
                    Image(systemName: "terminal")
                }
                .buttonStyle(.borderless)
                .disabled(!followEnabled)
                .help(followHelp)
                .accessibilityIdentifier("session-follow-\(session.id)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .opacity(isUnreachable ? 0.55 : 1)
    }

    @ViewBuilder
    private var icon: some View {
        if isUnreachable {
            Image(systemName: "icloud.slash")
                .font(.system(size: 15))
                .frame(width: 28, height: 28)
                .foregroundStyle(.secondary)
        } else if let localBrowserIcon {
            ZStack(alignment: .bottomTrailing) {
                Image(nsImage: localBrowserIcon)
                    .resizable()
                    .frame(width: 28, height: 28)
                Image(systemName: "icloud.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(.white)
                    .padding(1)
                    .background(Circle().fill(.blue))
                    .offset(x: 2, y: 2)
            }
        } else {
            Image(systemName: "icloud")
                .font(.system(size: 15))
                .frame(width: 28, height: 28)
                .foregroundStyle(.blue)
        }
    }

    private var subtitle: String {
        TraySessionPresentation.subtitle(
            isLocal: isLocal,
            deviceName: session.deviceName,
            lastSeenAt: session.lastSeenAt,
            verdict: verdict
        )
    }

    private var isUnreachable: Bool {
        verdict == .unreachable
    }

    private var attachBrowserEnabled: Bool {
        TraySessionPresentation.remoteActionEnabled(
            available: canAttachBrowser,
            verdict: verdict
        )
    }

    private var followEnabled: Bool {
        TraySessionPresentation.remoteActionEnabled(available: canFollow, verdict: verdict)
    }

    private var attachBrowserHelp: String {
        if isUnreachable { return "Session is not responding" }
        return canAttachBrowser ? "Attach a browser to this session" : "Install a supported browser to attach"
    }

    private var followHelp: String {
        if isUnreachable { return "Session is not responding" }
        return canFollow ? "Follow in a terminal" : "Install a supported terminal to follow"
    }
}

struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 4)
    }
}

enum AppRowStatusDot {
    case runningWithDebug
    case runningWithoutDebug
    case needsPermission
    case needsDebugBuild
    case needsLeader
    case failed
}

struct AppRow: View {
    let target: AppTarget
    let runtimeState: AppRuntimeState
    let onLaunch: () -> Void
    let onCreateDebugBuild: (() -> Void)?
    let subtitleOverride: String?
    let interactionDisabled: Bool

    init(
        target: AppTarget,
        runtimeState: AppRuntimeState,
        onLaunch: @escaping () -> Void,
        onCreateDebugBuild: (() -> Void)?,
        subtitleOverride: String? = nil,
        interactionDisabled: Bool = false
    ) {
        self.target = target
        self.runtimeState = runtimeState
        self.onLaunch = onLaunch
        self.onCreateDebugBuild = onCreateDebugBuild
        self.subtitleOverride = subtitleOverride
        self.interactionDisabled = interactionDisabled
    }

    private var isDisabled: Bool {
        AppRow.isDisabled(runtimeState: runtimeState, interactionDisabled: interactionDisabled)
    }

    static func isDisabled(runtimeState: AppRuntimeState, interactionDisabled: Bool) -> Bool {
        runtimeState == .cannotStart(.needsLeader) || interactionDisabled
    }

    var body: some View {
        Button {
            onLaunch()
        } label: {
            HStack(spacing: 10) {
                ZStack(alignment: .bottomTrailing) {
                    Image(nsImage: target.icon)
                        .resizable().frame(width: 28, height: 28)
                    if target.isDebugBuild {
                        Image(systemName: "wrench.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(.white)
                            .padding(2)
                            .background(Circle().fill(.blue))
                            .offset(x: 2, y: 2)
                    }
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(target.name)
                        .font(.system(size: 13))
                    if let subtitle {
                        Text(subtitle)
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if let dot = statusDot {
                    Circle().fill(dot.color).frame(width: 7, height: 7)
                        .help(dot.help)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .help(isDisabled ? AppRowStatusDot.needsLeader.help : "")
        .accessibilityIdentifier("app-row-\(target.name)")
        .accessibilityLabel(target.name)
        .onHover { hovering in
            // Avoid the pointing-hand affordance when the row is disabled
            // — the user can't actually start the app without a leader.
            guard !isDisabled else { return }
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    private var statusDot: AppRowStatusDot? {
        AppRow.statusDot(for: runtimeState)
    }

    private var subtitle: String? {
        AppRow.subtitle(
            for: runtimeState,
            override: subtitleOverride,
            isDebugBuild: target.isDebugBuild
        )
    }

    // Pure state → display mappings, split out from the computed view
    // properties so every branch is unit-testable without rendering the row.
    static func statusDot(for runtimeState: AppRuntimeState) -> AppRowStatusDot? {
        switch runtimeState {
        case .notRunning:
            return nil
        case .runningWithoutDebug:
            return .runningWithoutDebug
        case .runningWithDebug:
            return .runningWithDebug
        case .startFailed:
            return .failed
        case .cannotStart(.needsDebugBuild):
            return .needsDebugBuild
        case .cannotStart(.needsPermission):
            return .needsPermission
        case .cannotStart(.needsLeader):
            return .needsLeader
        }
    }

    static func subtitle(
        for runtimeState: AppRuntimeState,
        override: String?,
        isDebugBuild: Bool
    ) -> String? {
        if let override { return override }
        switch runtimeState {
        case .notRunning:
            return isDebugBuild ? "Debug Build" : nil
        case .runningWithoutDebug:
            return "Running without SLICC"
        case .runningWithDebug(let cdpPort):
            if let cdpPort {
                return "Running with SLICC on \(cdpPort)"
            }
            return "Running with SLICC"
        case .startFailed:
            return "Start failed"
        case .cannotStart(.needsDebugBuild):
            return "Needs Debug Build"
        case .cannotStart(.needsPermission):
            return "Needs Permission"
        case .cannotStart(.needsLeader):
            return "Start a browser first"
        }
    }
}

extension AppRowStatusDot {
    var color: Color {
        switch self {
        case .runningWithDebug:
            return .green
        case .runningWithoutDebug, .needsPermission:
            return .yellow
        case .needsDebugBuild, .failed:
            return .red
        case .needsLeader:
            return .gray
        }
    }

    var help: String {
        switch self {
        case .runningWithDebug:
            return "Running with SLICC."
        case .runningWithoutDebug:
            return "Running without a known SLICC debug port. Click to restart."
        case .needsDebugBuild:
            return "Remote debugging disabled. Click to create a debug build."
        case .needsPermission:
            return "App Management permission required. Click to open System Settings."
        case .needsLeader:
            return "Start a browser first to enable this app."
        case .failed:
            return "The last start attempt failed. Click to retry."
        }
    }
}

/// Makes a row draggable to reorder its list. Live-reorders as the drag hovers
/// over sibling rows and persists the new bundle-id order via `onCommit`.
struct ReorderableRow: ViewModifier {
    let target: AppTarget
    @Binding var order: [String]
    let displayed: [AppTarget]
    @Binding var dragging: String?
    let onCommit: ([String]) -> Void

    func body(content: Content) -> some View {
        content
            .opacity(dragging == target.bundleId ? 0.5 : 1)
            .onDrag {
                dragging = target.bundleId
                return NSItemProvider(object: (target.bundleId ?? target.id) as NSString)
            }
            .onDrop(
                of: [.text],
                delegate: ReorderDropDelegate(
                    target: target,
                    order: $order,
                    displayed: displayed,
                    dragging: $dragging,
                    onCommit: onCommit
                )
            )
    }
}

private struct ReorderDropDelegate: DropDelegate {
    let target: AppTarget
    @Binding var order: [String]
    let displayed: [AppTarget]
    @Binding var dragging: String?
    let onCommit: ([String]) -> Void

    // The on-screen order already merges the saved order with any app
    // installed after it was saved (AppOrdering appends the newcomers), so
    // keying off `displayed` — not the raw saved `order` — lets a freshly
    // installed browser/terminal be dragged too.
    private var currentIds: [String] {
        AppOrdering.persistableOrder(from: displayed)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let dragging, let over = target.bundleId else { return }
        let ids = AppOrdering.reorder(currentIds, moving: dragging, over: over)
        guard ids != currentIds else { return }
        order = ids
        onCommit(ids)
    }

    func performDrop(info: DropInfo) -> Bool {
        dragging = nil
        return true
    }
}
