import AppUpdater
import SwiftUI

/// The launcher window's content: setup progress, debug-build progress, or the
/// app list, plus the alerts and the timers that keep the list honest.
///
/// Extracted from `SliccstartApp`'s `WindowGroup` so it is a `View` — an
/// `App`'s `Scene` cannot be rendered, so as long as this lived inline none of
/// it could be reached by a test. Every callback here is one line into
/// ``LauncherModel``, which is where the behavior (and its tests) live.
struct RootView: View {
    @Bindable var model: LauncherModel
    @ObservedObject var appUpdater: AppUpdater
    /// Injected so a test renders the same footer a packaged build shows;
    /// a test process is never a bundled `.app`.
    var isBundledBuild: Bool = SliccBootstrapper.isBundled

    private let runtimeRefreshTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()
    // Re-advertise a still-running leader well inside the sync store's 12h TTL
    // so a continuously-open leader is never pruned from other devices.
    private let sessionRepublishTimer = Timer.publish(every: 4 * 60 * 60, on: .main, in: .common)
        .autoconnect()

    private var isUpdateDownloaded: Bool {
        if case .downloaded = appUpdater.state { return true }
        return false
    }

    var body: some View {
        content
            .task { await model.initialize() }
            .onAppear { model.permission.startWatchingForGrant() }
            .onDisappear { model.permission.stopWatchingForGrant() }
            .onReceive(runtimeRefreshTimer) { _ in
                model.runtimeTick(isUpdateDownloaded: isUpdateDownloaded)
            }
            .onReceive(
                NotificationCenter.default.publisher(
                    for: NSApplication.didBecomeActiveNotification)
            ) { _ in
                model.refreshRuntimeStatesOnActivate()
            }
            .onChange(of: model.process.leaderJoinUrl) { _, newValue in
                model.leaderJoinUrlChanged(newValue)
            }
            .onReceive(sessionRepublishTimer) { _ in model.republishLeaderSession() }
            .onChange(of: model.permission.isGranted) { model.appManagementPermissionChanged() }
            .alert("Sliccstart", isPresented: $model.showAlert) {
                Button("OK") {}
            } message: {
                Text(model.alertMessage ?? "")
            }
            .alert("Enable Debug Build", isPresented: $model.showDebugBuildDialog) {
                Button("Cancel", role: .cancel) { model.cancelDebugBuild() }
                Button("Create Debug Build") {
                    Task { await model.confirmDebugBuild() }
                }
            } message: {
                if let target = model.debugBuildTarget {
                    Text(RootView.debugBuildPrompt(for: target))
                }
            }
            .alert("Restart App for SLICC?", isPresented: $model.showElectronRestartDialog) {
                Button("Cancel", role: .cancel) { model.cancelElectronRestart() }
                Button("Restart") { model.confirmElectronRestart() }
            } message: {
                if let target = model.electronRestartTarget {
                    Text(RootView.electronRestartPrompt(for: target))
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if !model.isReady {
            SetupProgressView(
                message: model.bootstrapper.progressMessage.isEmpty
                    ? "Checking installation..." : model.bootstrapper.progressMessage,
                isWorking: model.bootstrapper.isWorking,
                error: model.bootstrapper.lastError,
                onRetry: { Task { await model.initialize() } }
            )
        } else if model.isCreatingDebugBuild {
            SetupProgressView(
                message: model.debugBuildProgress.isEmpty
                    ? "Creating debug build..." : model.debugBuildProgress,
                isWorking: true,
                error: nil,
                onRetry: {}
            )
        } else {
            AppListView(
                targets: model.targets,
                sliccProcess: model.process,
                sessionStore: model.sessionStore,
                appManagementPermission: model.permission,
                appUpdater: appUpdater,
                updateCheckStatus: model.updateCheckStatus,
                hasRecentAgentActivity: model.hasRecentAgentActivity,
                onCheckForUpdates: { model.checkForUpdates() },
                onLaunchStandalone: { model.launchStandalone($0) },
                onLaunchBrowserFollower: { model.launchBrowserFollower($0, joinUrl: $1) },
                onLaunchElectron: { model.handleElectronLaunch($0) },
                onCreateDebugBuild: { model.requestDebugBuild(for: $0) },
                onUpdate: { Task { await model.updateRuntime() } },
                onBeginUpdate: { model.beginAppUpdate() },
                onRescan: { model.rescan() },
                isBundledBuild: isBundledBuild
            )
        }
    }

    // Prompt copy lives in static functions so it is assertable without a
    // presented alert — SwiftUI builds alert content lazily, and nothing
    // renders it off-screen.

    static func debugBuildPrompt(for target: AppTarget) -> String {
        """
        \(target.name) has remote debugging disabled.

        Create a debug build in ~/Applications that enables SLICC to connect?

        This will:
        • Copy the app to ~/Applications/\(target.name) Debug.app
        • Patch Electron fuses
        • Bypass CDP auth checks
        • Ad-hoc sign the result
        """
    }

    static func electronRestartPrompt(for target: AppTarget) -> String {
        """
        \(target.name) is already running without a known SLICC debug port.

        Sliccstart can quit and reopen it with remote debugging enabled.
        """
    }
}
