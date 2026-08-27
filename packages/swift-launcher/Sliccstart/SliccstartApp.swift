import AppKit
import AppUpdater
import Combine
import SliccTraySession
import SwiftOptel
import SwiftUI
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "App")

/// Delegate that terminates all launched SLICC processes when the app quits.
/// Owns the SliccProcess instance so it stays alive for the entire app lifetime.
///
/// When `sliccProcess.isPreparingForUpdate` is true (the user just clicked
/// "Restart to Update"), we instead persist the launch records and SIGUSR1
/// every slicc-server child so the browsers/Electron apps survive. The new
/// Sliccstart reattaches on next launch in `SliccstartApp.initialize()`.
final class SliccstartAppDelegate: NSObject, NSApplicationDelegate {
    let sliccProcess = SliccProcess()
    let sessionStore = TraySessionSyncStore()
    let fileProviderCoordinator = FileProviderCoordinator()
    /// Feeds the Cones & Scoops widget. Dials the leader only when a widget is
    /// actually installed — see `WidgetTrayObserver`. `@MainActor` and lazy so
    /// the delegate's own (nonisolated) init does not have to build it.
    @MainActor lazy var widgetTrayObserver = WidgetTrayObserver()
    /// Created on the first incoming link (only reachable while Sliccstart is
    /// the default web browser, or the handler for an HTML document) and kept
    /// afterwards, so its queue survives a burst of clicks.
    @MainActor private var urlRouter: IncomingURLRouter?

    /// Links macOS routes to us because we hold the http/https handler role.
    /// Sliccstart shows no web content itself, so each one becomes a tab in
    /// the SLICC leader browser — started on demand when it isn't running.
    func application(_ application: NSApplication, open urls: [URL]) {
        log.info("application(open:): \(urls.count, privacy: .public) url(s)")
        let process = sliccProcess
        Task { @MainActor in
            let router = urlRouter ?? IncomingURLRouter(process: process)
            urlRouter = router
            await router.handle(urls)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if sliccProcess.isPreparingForUpdate {
            // Browsers survive the update and the tray stays live, so leave
            // this device's session advertised — the relaunched Sliccstart
            // republishes it after reattach.
            log.info("applicationWillTerminate: detaching for update")
            sliccProcess.detachAll()
            return
        }
        log.info("applicationWillTerminate: stopping all processes")
        sliccProcess.stopAll()
        // The leader is going away, so stop advertising it to other devices.
        sessionStore.withdrawLocalSessions()
        fileProviderCoordinator.withdrawOnQuit()
        MainActor.assumeIsolated { widgetTrayObserver.stop() }
    }
}

struct SliccstartApp: App {
    @NSApplicationDelegateAdaptor private var appDelegate: SliccstartAppDelegate
    @State private var bootstrapper = SliccBootstrapper()
    @State private var appManagementPermission = AppManagementPermission()
    @State private var targets: [AppTarget] = []
    @State private var isReady = false
    @State private var alertMessage: String?
    @State private var showAlert = false
    @State private var showDebugBuildDialog = false
    @State private var debugBuildTarget: AppTarget?
    @State private var showElectronRestartDialog = false
    @State private var electronRestartTarget: AppTarget?
    @State private var isCreatingDebugBuild = false
    @State private var debugBuildProgress: String = ""
    @State private var updateCheckStatus: UpdateCheckStatus = .idle
    @State private var hasRecentAgentActivity = false
    @StateObject private var appUpdater = AppUpdater(
        owner: "ai-ecoverse",
        repo: "slicc",
        releasePrefix: "Sliccstart",
        provider: TolerantGithubReleaseProvider(
            host: UpdateHostConfiguration.resolve(),
            releasePrefix: "Sliccstart"
        )
    )
    private let runtimeRefreshTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()
    // Re-advertise a still-running leader well inside the sync store's 12h TTL
    // so a continuously-open leader is never pruned from other devices.
    private let sessionRepublishTimer = Timer.publish(every: 4 * 60 * 60, on: .main, in: .common).autoconnect()

    private let optelAppID = Bundle.main.bundleIdentifier ?? "unknown.app"

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private var sliccProcess: SliccProcess { appDelegate.sliccProcess }
    private var sessionStore: TraySessionSyncStore { appDelegate.sessionStore }
    private var fileProviderCoordinator: FileProviderCoordinator { appDelegate.fileProviderCoordinator }
    private var widgetTrayObserver: WidgetTrayObserver { appDelegate.widgetTrayObserver }
    private var isUpdateDownloaded: Bool {
        if case .downloaded = appUpdater.state { return true }
        return false
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if !isReady {
                    SetupProgressView(
                        message: bootstrapper.progressMessage.isEmpty ? "Checking installation..." : bootstrapper.progressMessage,
                        isWorking: bootstrapper.isWorking,
                        error: bootstrapper.lastError,
                        onRetry: { Task { await initialize() } }
                    )
                } else if isCreatingDebugBuild {
                    SetupProgressView(
                        message: debugBuildProgress.isEmpty ? "Creating debug build..." : debugBuildProgress,
                        isWorking: true,
                        error: nil,
                        onRetry: {}
                    )
                } else {
                    AppListView(
                        targets: targets,
                        sliccProcess: sliccProcess,
                        sessionStore: sessionStore,
                        appManagementPermission: appManagementPermission,
                        appUpdater: appUpdater,
                        updateCheckStatus: updateCheckStatus,
                        hasRecentAgentActivity: hasRecentAgentActivity,
                        onCheckForUpdates: { checkForUpdates() },
                        onLaunchStandalone: { target in
                            log.info("onLaunchStandalone: \(target.name, privacy: .public)")
                            do {
                                try sliccProcess.launchStandalone(target)
                            } catch {
                                log.error("onLaunchStandalone failed: \(error.localizedDescription, privacy: .public)")
                                LauncherErrorReport.report(.launchStandalone, error)
                                showError(error.localizedDescription)
                            }
                        },
                        onLaunchBrowserFollower: { target, joinUrl in
                            log.info("onLaunchBrowserFollower: \(target.name, privacy: .public)")
                            do {
                                try sliccProcess.launchBrowserFollower(target, joinUrl: joinUrl)
                            } catch {
                                log.error("onLaunchBrowserFollower failed: \(error.localizedDescription, privacy: .public)")
                                LauncherErrorReport.report(.launchStandalone, error)
                                showError(error.localizedDescription)
                            }
                        },
                        onLaunchElectron: { target in
                            log.info("onLaunchElectron: \(target.name, privacy: .public)")
                            handleElectronLaunch(target)
                        },
                        onCreateDebugBuild: { target in
                            debugBuildTarget = target
                            showDebugBuildDialog = true
                        },
                        onUpdate: {
                            Task {
                                isReady = false
                                do {
                                    try await bootstrapper.update()
                                } catch {
                                    log.error("onUpdate failed: \(error.localizedDescription, privacy: .public)")
                                    LauncherErrorReport.report(.bootstrapUpdate, error)
                                    bootstrapper.lastError = error.localizedDescription
                                    bootstrapper.progressMessage = error.localizedDescription
                                }
                                targets = AppScanner.scan(hasAppManagementPermission: appManagementPermission.isGranted)
                                isReady = true
                            }
                        },
                        onBeginUpdate: {
                            // Persist + detach BEFORE AppUpdater swaps the
                            // .app and relaunches us. After this returns,
                            // every browser/Electron app keeps running and
                            // launch-records.json describes how to find
                            // them again.
                            log.info("onBeginUpdate: detaching for AppUpdater install")
                            sliccProcess.isPreparingForUpdate = true
                            sliccProcess.detachAll()
                        },
                        onRescan: { targets = AppScanner.scan(hasAppManagementPermission: appManagementPermission.isGranted) }
                    )
                }
            }
            .frame(width: 340)
            .optelAutoInstrument(appID: optelAppID)
            .task { await initialize() }
            .onAppear { appManagementPermission.startWatchingForGrant() }
            .onDisappear { appManagementPermission.stopWatchingForGrant() }
            .onReceive(runtimeRefreshTimer) { _ in
                guard isReady else { return }
                sliccProcess.refreshRuntimeStates(for: targets)
                guard isUpdateDownloaded else {
                    hasRecentAgentActivity = false
                    return
                }
                Task {
                    let isActive = await sliccProcess.hasRecentAgentActivity()
                    hasRecentAgentActivity = isUpdateDownloaded ? isActive : false
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                guard isReady else { return }
                sliccProcess.refreshRuntimeStates(for: targets)
            }
            .onChange(of: sliccProcess.leaderJoinUrl) { _, newValue in
                // Advertise this device's leader session over iCloud when it
                // becomes ready, and withdraw it when the leader goes away.
                if let joinUrl = newValue, !joinUrl.isEmpty {
                    let label = sliccProcess.leaderTargetName ?? "SLICC"
                    sessionStore.publish(joinUrl: joinUrl, label: label)
                    fileProviderCoordinator.leaderJoinUrlChanged(joinUrl, label: label)
                    widgetTrayObserver.leaderChanged(joinUrl: joinUrl, label: label)
                } else {
                    sessionStore.withdrawLocalSessions()
                    fileProviderCoordinator.leaderJoinUrlChanged(nil, label: nil)
                    widgetTrayObserver.leaderChanged(joinUrl: nil, label: nil)
                }
            }
            .onReceive(sessionRepublishTimer) { _ in
                // Refresh lastSeenAt on a live leader so it never ages out of
                // the sync store's TTL while it is still running.
                guard isReady, let joinUrl = sliccProcess.leaderJoinUrl, !joinUrl.isEmpty else { return }
                sessionStore.publish(joinUrl: joinUrl, label: sliccProcess.leaderTargetName ?? "SLICC")
                // Same beat: pick up a widget the user added since the leader
                // started, without a notification WidgetKit does not send.
                widgetTrayObserver.refresh()
            }
            .onChange(of: appManagementPermission.isGranted) {
                // Re-scan when permission is granted so Electron apps appear
                if isReady {
                    targets = AppScanner.scan(hasAppManagementPermission: appManagementPermission.isGranted)
                }
            }
            .alert("Sliccstart", isPresented: $showAlert) {
                Button("OK") {}
            } message: {
                Text(alertMessage ?? "")
            }
            .alert("Enable Debug Build", isPresented: $showDebugBuildDialog) {
                Button("Cancel", role: .cancel) {
                    debugBuildTarget = nil
                }
                Button("Create Debug Build") {
                    if let target = debugBuildTarget {
                        Task {
                            await createDebugBuild(for: target)
                        }
                    }
                }
            } message: {
                if let target = debugBuildTarget {
                    Text(
                        "\(target.name) has remote debugging disabled.\n\nCreate a debug build in ~/Applications that enables SLICC to connect?\n\nThis will:\n• Copy the app to ~/Applications/\(target.name) Debug.app\n• Patch Electron fuses\n• Bypass CDP auth checks\n• Ad-hoc sign the result"
                    )
                }
            }
            .alert("Restart App for SLICC?", isPresented: $showElectronRestartDialog) {
                Button("Cancel", role: .cancel) {
                    electronRestartTarget = nil
                }
                Button("Restart") {
                    if let target = electronRestartTarget {
                        launchElectron(target, forceRestartExistingApp: true)
                    }
                    electronRestartTarget = nil
                }
            } message: {
                if let target = electronRestartTarget {
                    Text(
                        "\(target.name) is already running without a known SLICC debug port.\n\nSliccstart can quit and reopen it with remote debugging enabled."
                    )
                }
            }
        }
        .defaultSize(width: 340, height: 100)
        .windowStyle(.titleBar)
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") {
                    checkForUpdates()
                }
            }
        }

        Settings {
            SettingsView(fileProviderCoordinator: appDelegate.fileProviderCoordinator)
        }
    }

    private func initialize() async {
        let sliccDir = sliccProcess.resolvedSliccDir
        let status = SliccBootstrapper.checkInstallation(sliccDir: sliccDir)
        if status != .installed && status != .needsBuild {
            do {
                try await bootstrapper.bootstrap()
            } catch {
                log.error("initialize: bootstrap failed: \(error.localizedDescription, privacy: .public)")
                LauncherErrorReport.report(.bootstrap, error)
                bootstrapper.lastError = error.localizedDescription
                bootstrapper.progressMessage = error.localizedDescription
                return
            }
        }

        targets = AppScanner.scan(hasAppManagementPermission: appManagementPermission.isGranted)

        // Reattach to any browsers/Electron apps that the previous
        // Sliccstart left running while it relaunched for an update.
        let reattached = await sliccProcess.reattachPersistedRecords(targets: targets)
        if !reattached.isEmpty {
            log.info("initialize: reattached \(reattached.count) running runtime(s)")
            // Refresh runtime states so the UI immediately shows the
            // green "Running with SLICC" dot.
            sliccProcess.refreshRuntimeStates(for: targets)
        }

        isReady = true

        // Check for app updates in bundled mode
        if SliccBootstrapper.isBundled {
            checkForUpdates()
        }

        // Skip the configured-browser auto-launch when we just reattached —
        // the user's previous session is already alive.
        if reattached.isEmpty {
            autoLaunchConfiguredBrowser()
        }
    }

    /// Runs an update check and records the outcome so the footer can report
    /// it. Every `AppUpdater` failure — rate limits, a release window without
    /// an installable macOS asset, a code-signing mismatch — arrives here and
    /// would otherwise be dropped, leaving the UI claiming nothing to update.
    private func checkForUpdates() {
        guard updateCheckStatus.allowsRetry else { return }
        log.info("checkForUpdates: starting")
        updateCheckStatus = .checking
        appUpdater.check(
            success: {
                Task { @MainActor in
                    let ready = appUpdater.state.release != nil
                    log.info("checkForUpdates: finished, update ready = \(ready, privacy: .public)")
                    updateCheckStatus = ready ? .idle : .upToDate
                }
            },
            fail: { error in
                Task { @MainActor in
                    let status = UpdateCheckStatus.from(error: error)
                    log.error("checkForUpdates: failed: \(String(describing: error), privacy: .public)")
                    // `upToDate` is AppUpdater's way of saying "nothing newer",
                    // not a fault — reporting it would drown the real failures.
                    if status != .upToDate {
                        LauncherErrorReport.report(.updateCheck, error)
                    }
                    updateCheckStatus = status
                }
            }
        )
    }

    /// Launch the top browser at startup when the Settings > Startup checkbox
    /// is enabled. The browser is the head of the (reorderable) Browsers list.
    /// Failures are logged but never block startup.
    private func autoLaunchConfiguredBrowser() {
        guard StartupPreference.resolveEnabled(defaults: .standard) else { return }
        guard
            let target = AppOrdering.topBrowser(
                in: targets,
                savedOrder: AppOrderStore().load(AppOrderStore.browserKey)
            )
        else {
            log.info("autoLaunch: no browser available to launch")
            return
        }
        log.info("autoLaunch: launching \(target.name, privacy: .public)")
        do {
            try sliccProcess.launchStandalone(target)
        } catch {
            log.error("autoLaunch failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.autoLaunch, error)
        }
    }

    private func createDebugBuild(for target: AppTarget) async {
        isCreatingDebugBuild = true
        debugBuildProgress = "Starting..."

        do {
            _ = try await DebugBuildCreator.createDebugBuild(from: target.path) { progress in
                Task { @MainActor in
                    debugBuildProgress = progress
                }
            }
            // Rescan to pick up the new debug build
            targets = AppScanner.scan(hasAppManagementPermission: appManagementPermission.isGranted)
            showError("Debug build created!\n\nThe patched version of \(target.name) is now available and will be used automatically.")
        } catch {
            log.error("createDebugBuild failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.debugBuild, error)
            showError("Failed to create debug build:\n\n\(error.localizedDescription)")
        }

        isCreatingDebugBuild = false
        debugBuildTarget = nil
    }

    private func handleElectronLaunch(_ target: AppTarget) {
        sliccProcess.refreshRuntimeStates(for: [target])
        let state = sliccProcess.runtimeState(
            for: target,
            hasAppManagementPermission: appManagementPermission.isGranted
        )

        switch state {
        case .runningWithDebug:
            return
        case .runningWithoutDebug:
            electronRestartTarget = target
            showElectronRestartDialog = true
        case .cannotStart(.needsDebugBuild):
            debugBuildTarget = target
            showDebugBuildDialog = true
        case .cannotStart(.needsPermission):
            appManagementPermission.openSystemSettings()
        case .cannotStart(.needsLeader):
            // Row is disabled at the AppListView layer; the user can't
            // reach this path under normal interaction. No-op defensively
            // so a stray programmatic call doesn't try to start a follower
            // without a leader.
            log.info("handleElectronLaunch: \(target.name, privacy: .public) needs leader; ignoring")
        case .notRunning, .startFailed:
            launchElectron(target)
        }
    }

    private func launchElectron(_ target: AppTarget, forceRestartExistingApp: Bool = false) {
        do {
            try sliccProcess.launchWithElectronApp(
                target,
                forceRestartExistingApp: forceRestartExistingApp
            )
        } catch {
            log.error("onLaunchElectron failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.launchElectron, error)
            showError(error.localizedDescription)
        }
    }

    private func showError(_ message: String) {
        alertMessage = message
        showAlert = true
    }
}
