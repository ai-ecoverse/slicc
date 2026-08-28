import AppKit
import AppUpdater
import SliccTraySession
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "LauncherModel")

/// Everything the launcher window *does*, separated from the `Scene` that
/// shows it.
///
/// This used to live inline in `SliccstartApp`'s `WindowGroup` — closures
/// hanging off `AppListView`'s callbacks, `onReceive` handlers, and private
/// methods reading `@State`. None of it could be reached from a test: an
/// `App`'s `Scene` cannot be rendered, and its `@State` cannot be driven
/// outside the SwiftUI lifecycle. It was the single largest untested surface
/// in the app.
///
/// Every collaborator with a side effect — the app scan, the debug-build
/// creator, the update check, the startup preference — is injected with a
/// live default, so a test can drive the real decisions (which launch path a
/// row takes, what an update failure does to the footer, whether a reattach
/// suppresses auto-launch) without launching a browser or patching an `.app`.
@MainActor
@Observable
final class LauncherModel {

    /// The `AppUpdater` calls the launcher makes, as a value — the real one
    /// hits GitHub in its initializer's background scheduler.
    @MainActor
    struct UpdateChecking {
        var check: (@escaping () -> Void, @escaping (Error) -> Void) -> Void
        var isUpdateReady: () -> Bool

        static func live(_ updater: AppUpdater) -> UpdateChecking {
            UpdateChecking(
                check: { success, fail in updater.check(success: success, fail: fail) },
                isUpdateReady: { updater.state.release != nil }
            )
        }
    }

    // MARK: - Collaborators

    let process: SliccProcess
    let sessionStore: TraySessionSyncStore
    let fileProviderCoordinator: FileProviderCoordinator
    let widgetTrayObserver: WidgetTrayObserver
    let permission: AppManagementPermission
    let bootstrapper: SliccBootstrapper

    private let updateChecking: UpdateChecking
    private let scanApps: (Bool) -> [AppTarget]
    private let checkInstallation: (String) -> InstallationStatus
    private let makeDebugBuild: (String, @escaping (String) -> Void) async throws -> String
    private let isBundledBuild: () -> Bool
    private let startupLaunchEnabled: () -> Bool
    private let savedBrowserOrder: () -> [String]

    // MARK: - Window state

    var targets: [AppTarget] = []
    var isReady = false
    var alertMessage: String?
    var showAlert = false
    var showDebugBuildDialog = false
    var debugBuildTarget: AppTarget?
    var showElectronRestartDialog = false
    var electronRestartTarget: AppTarget?
    var isCreatingDebugBuild = false
    var debugBuildProgress = ""
    var updateCheckStatus: UpdateCheckStatus = .idle
    var hasRecentAgentActivity = false

    init(
        process: SliccProcess,
        sessionStore: TraySessionSyncStore,
        fileProviderCoordinator: FileProviderCoordinator,
        widgetTrayObserver: WidgetTrayObserver,
        permission: AppManagementPermission = AppManagementPermission(),
        bootstrapper: SliccBootstrapper = SliccBootstrapper(),
        updateChecking: UpdateChecking,
        scanApps: @escaping (Bool) -> [AppTarget] = { AppScanner.scan(hasAppManagementPermission: $0) },
        checkInstallation: @escaping (String) -> InstallationStatus = {
            SliccBootstrapper.checkInstallation(sliccDir: $0)
        },
        makeDebugBuild: @escaping (String, @escaping (String) -> Void) async throws -> String = {
            try await DebugBuildCreator.createDebugBuild(from: $0, progressHandler: $1)
        },
        isBundledBuild: @escaping () -> Bool = { SliccBootstrapper.isBundled },
        startupLaunchEnabled: @escaping () -> Bool = {
            StartupPreference.resolveEnabled(defaults: .standard)
        },
        savedBrowserOrder: @escaping () -> [String] = { AppOrderStore().load(AppOrderStore.browserKey) }
    ) {
        self.process = process
        self.sessionStore = sessionStore
        self.fileProviderCoordinator = fileProviderCoordinator
        self.widgetTrayObserver = widgetTrayObserver
        self.permission = permission
        self.bootstrapper = bootstrapper
        self.updateChecking = updateChecking
        self.scanApps = scanApps
        self.checkInstallation = checkInstallation
        self.makeDebugBuild = makeDebugBuild
        self.isBundledBuild = isBundledBuild
        self.startupLaunchEnabled = startupLaunchEnabled
        self.savedBrowserOrder = savedBrowserOrder
    }

    // MARK: - Startup

    /// Bootstrap if needed, scan, reattach anything the previous Sliccstart
    /// left running across an update, then either auto-launch or stay put.
    func initialize() async {
        let sliccDir = process.resolvedSliccDir
        let status = checkInstallation(sliccDir)
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

        rescan()

        // Reattach to any browsers/Electron apps that the previous
        // Sliccstart left running while it relaunched for an update.
        let reattached = await process.reattachPersistedRecords(targets: targets)
        if !reattached.isEmpty {
            log.info("initialize: reattached \(reattached.count) running runtime(s)")
            // Refresh runtime states so the UI immediately shows the
            // green "Running with SLICC" dot.
            process.refreshRuntimeStates(for: targets)
        }

        isReady = true

        if isBundledBuild() {
            checkForUpdates()
        }

        // Skip the configured-browser auto-launch when we just reattached —
        // the user's previous session is already alive.
        if reattached.isEmpty {
            autoLaunchConfiguredBrowser()
        }
    }

    func rescan() {
        targets = scanApps(permission.isGranted)
    }

    /// Launch the top browser at startup when the Settings > Startup checkbox
    /// is enabled. The browser is the head of the (reorderable) Browsers list.
    /// Failures are logged but never block startup.
    func autoLaunchConfiguredBrowser() {
        guard startupLaunchEnabled() else { return }
        guard let target = AppOrdering.topBrowser(in: targets, savedOrder: savedBrowserOrder()) else {
            log.info("autoLaunch: no browser available to launch")
            return
        }
        log.info("autoLaunch: launching \(target.name, privacy: .public)")
        do {
            try process.launchStandalone(target)
        } catch {
            log.error("autoLaunch failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.autoLaunch, error)
        }
    }

    // MARK: - Launching

    func launchStandalone(_ target: AppTarget) {
        log.info("onLaunchStandalone: \(target.name, privacy: .public)")
        do {
            try process.launchStandalone(target)
        } catch {
            log.error("onLaunchStandalone failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.launchStandalone, error)
            showError(error.localizedDescription)
        }
    }

    func launchBrowserFollower(_ target: AppTarget, joinUrl: String) {
        log.info("onLaunchBrowserFollower: \(target.name, privacy: .public)")
        do {
            try process.launchBrowserFollower(target, joinUrl: joinUrl)
        } catch {
            log.error("onLaunchBrowserFollower failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.launchStandalone, error)
            showError(error.localizedDescription)
        }
    }

    func handleElectronLaunch(_ target: AppTarget) {
        process.refreshRuntimeStates(for: [target])
        let state = process.runtimeState(
            for: target,
            hasAppManagementPermission: permission.isGranted
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
            permission.openSystemSettings()
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

    func launchElectron(_ target: AppTarget, forceRestartExistingApp: Bool = false) {
        do {
            try process.launchWithElectronApp(
                target,
                forceRestartExistingApp: forceRestartExistingApp
            )
        } catch {
            log.error("onLaunchElectron failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.launchElectron, error)
            showError(error.localizedDescription)
        }
    }

    // MARK: - Dialogs

    func requestDebugBuild(for target: AppTarget) {
        debugBuildTarget = target
        showDebugBuildDialog = true
    }

    func cancelDebugBuild() {
        debugBuildTarget = nil
    }

    /// The user accepted the "Enable Debug Build" dialog.
    func confirmDebugBuild() async {
        guard let target = debugBuildTarget else { return }
        await createDebugBuild(for: target)
    }

    func createDebugBuild(for target: AppTarget) async {
        isCreatingDebugBuild = true
        debugBuildProgress = "Starting..."

        do {
            _ = try await makeDebugBuild(target.path) { progress in
                Task { @MainActor in
                    self.debugBuildProgress = progress
                }
            }
            // Rescan to pick up the new debug build
            rescan()
            showError(
                "Debug build created!\n\nThe patched version of \(target.name) is now available and will be used automatically."
            )
        } catch {
            log.error("createDebugBuild failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.debugBuild, error)
            showError("Failed to create debug build:\n\n\(error.localizedDescription)")
        }

        isCreatingDebugBuild = false
        debugBuildTarget = nil
    }

    func cancelElectronRestart() {
        electronRestartTarget = nil
    }

    /// The user accepted the "Restart App for SLICC?" dialog.
    func confirmElectronRestart() {
        if let target = electronRestartTarget {
            launchElectron(target, forceRestartExistingApp: true)
        }
        electronRestartTarget = nil
    }

    func showError(_ message: String) {
        alertMessage = message
        showAlert = true
    }

    // MARK: - Updates

    /// Runs an update check and records the outcome so the footer can report
    /// it. Every `AppUpdater` failure — rate limits, a release window without
    /// an installable macOS asset, a code-signing mismatch — arrives here and
    /// would otherwise be dropped, leaving the UI claiming nothing to update.
    func checkForUpdates() {
        guard updateCheckStatus.allowsRetry else { return }
        log.info("checkForUpdates: starting")
        updateCheckStatus = .checking
        updateChecking.check(
            {
                Task { @MainActor in
                    let ready = self.updateChecking.isUpdateReady()
                    log.info("checkForUpdates: finished, update ready = \(ready, privacy: .public)")
                    self.updateCheckStatus = ready ? .idle : .upToDate
                }
            },
            { error in
                Task { @MainActor in
                    let status = UpdateCheckStatus.from(error: error)
                    log.error("checkForUpdates: failed: \(String(describing: error), privacy: .public)")
                    // `upToDate` is AppUpdater's way of saying "nothing newer",
                    // not a fault — reporting it would drown the real failures.
                    if status != .upToDate {
                        LauncherErrorReport.report(.updateCheck, error)
                    }
                    self.updateCheckStatus = status
                }
            }
        )
    }

    /// Re-run the SLICC runtime bootstrap (unbundled builds only). Drops back
    /// to the setup screen for the duration.
    func updateRuntime() async {
        isReady = false
        do {
            try await bootstrapper.update()
        } catch {
            log.error("onUpdate failed: \(error.localizedDescription, privacy: .public)")
            LauncherErrorReport.report(.bootstrapUpdate, error)
            bootstrapper.lastError = error.localizedDescription
            bootstrapper.progressMessage = error.localizedDescription
        }
        rescan()
        isReady = true
    }

    /// Persist + detach BEFORE AppUpdater swaps the `.app` and relaunches us.
    /// After this returns, every browser/Electron app keeps running and
    /// launch-records.json describes how to find them again.
    func beginAppUpdate() {
        log.info("onBeginUpdate: detaching for AppUpdater install")
        process.isPreparingForUpdate = true
        process.detachAll()
    }

    // MARK: - Periodic work

    /// The 2s runtime tick: refresh what each row shows, and — only while an
    /// update is staged — ask whether an agent is mid-run, so the restart
    /// affordance can discourage interrupting it.
    func runtimeTick(isUpdateDownloaded: Bool) {
        guard isReady else { return }
        process.refreshRuntimeStates(for: targets)
        guard isUpdateDownloaded else {
            hasRecentAgentActivity = false
            return
        }
        Task {
            let isActive = await process.hasRecentAgentActivity()
            hasRecentAgentActivity = isUpdateDownloaded ? isActive : false
        }
    }

    func refreshRuntimeStatesOnActivate() {
        guard isReady else { return }
        process.refreshRuntimeStates(for: targets)
    }

    /// Advertise this device's leader session over iCloud when it becomes
    /// ready, and withdraw it when the leader goes away. The File Provider and
    /// the widget observer hang off the same signal — `leaderJoinUrl` is the
    /// launcher's one piece of session identity.
    func leaderJoinUrlChanged(_ newValue: String?) {
        if let joinUrl = newValue, !joinUrl.isEmpty {
            let label = process.leaderTargetName ?? "SLICC"
            sessionStore.publish(joinUrl: joinUrl, label: label)
            fileProviderCoordinator.leaderJoinUrlChanged(joinUrl, label: label)
            widgetTrayObserver.leaderChanged(joinUrl: joinUrl, label: label)
        } else {
            sessionStore.withdrawLocalSessions()
            fileProviderCoordinator.leaderJoinUrlChanged(nil, label: nil)
            widgetTrayObserver.leaderChanged(joinUrl: nil, label: nil)
        }
    }

    /// Refresh `lastSeenAt` on a live leader so it never ages out of the sync
    /// store's TTL while it is still running.
    func republishLeaderSession() {
        guard isReady, let joinUrl = process.leaderJoinUrl, !joinUrl.isEmpty else { return }
        sessionStore.publish(joinUrl: joinUrl, label: process.leaderTargetName ?? "SLICC")
        // Same beat: pick up a widget the user added since the leader
        // started, without a notification WidgetKit does not send.
        widgetTrayObserver.refresh()
    }

    /// Re-scan when App Management permission is granted so Electron apps appear.
    func appManagementPermissionChanged() {
        guard isReady else { return }
        rescan()
    }
}
