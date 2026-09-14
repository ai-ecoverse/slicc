import AppKit
import AppUpdater
import SliccTraySession
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "LauncherModel")
















@MainActor
@Observable
final class LauncherModel {

    
    
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
            StartupPreference.shouldAutoLaunch(defaults: .standard)
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

        
        
        let reattached = await process.reattachPersistedRecords(targets: targets)
        if !reattached.isEmpty {
            log.info("initialize: reattached \(reattached.count) running runtime(s)")
            
            
            process.refreshRuntimeStates(for: targets)
        }

        isReady = true

        
        
        
        process.startLeaderJoinUrlWatch()

        if isBundledBuild() {
            checkForUpdates()
        }

        
        
        if reattached.isEmpty {
            autoLaunchConfiguredBrowser()
        }
    }

    func rescan() {
        targets = scanApps(permission.isGranted)
    }

    
    
    
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

    

    func requestDebugBuild(for target: AppTarget) {
        debugBuildTarget = target
        showDebugBuildDialog = true
    }

    func cancelDebugBuild() {
        debugBuildTarget = nil
    }

    
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
                    
                    
                    if status != .upToDate {
                        LauncherErrorReport.report(.updateCheck, error)
                    }
                    self.updateCheckStatus = status
                }
            }
        )
    }

    
    
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

    
    
    
    func beginAppUpdate() {
        log.info("onBeginUpdate: detaching for AppUpdater install")
        process.isPreparingForUpdate = true
        process.detachAll()
    }

    

    
    
    
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

    
    
    
    
    
    
    
    
    
    func leaderJoinUrlChanged(_ newValue: String?, previous: String? = nil) {
        if let previous, !previous.isEmpty, previous != newValue {
            sessionStore.withdraw(joinUrl: previous)
        }
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

    
    
    
    
    
    
    
    
    
    
    func republishLeaderSession() {
        guard isReady else { return }
        Task { [weak self] in
            guard let self else { return }
            guard let joinUrl = await process.refreshLeaderJoinUrl(maxAttempts: 3) else {
                log.info("republishLeaderSession: leader did not answer — letting the advertisement age out")
                return
            }
            
            
            
            sessionStore.publish(joinUrl: joinUrl, label: process.leaderTargetName ?? "SLICC")
            
            
            widgetTrayObserver.refresh()
        }
    }

    
    func appManagementPermissionChanged() {
        guard isReady else { return }
        rescan()
    }
}
