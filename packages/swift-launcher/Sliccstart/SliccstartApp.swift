import SwiftUI
import AppKit
import Combine
import os
import AppUpdater
import SwiftOptel

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

    func applicationWillTerminate(_ notification: Notification) {
        if sliccProcess.isPreparingForUpdate {
            log.info("applicationWillTerminate: detaching for update")
            sliccProcess.detachAll()
            return
        }
        log.info("applicationWillTerminate: stopping all processes")
        sliccProcess.stopAll()
    }
}

/// Entry point that branches into the headless updater probe when the
/// binary is invoked with `--probe-update`. The probe path never returns
/// (it calls `exit()` after writing its JSON to stdout), so the SwiftUI
/// app only starts when the user is running normally.
@main
struct SliccstartEntryPoint {
    static func main() {
        UpdateProbeCommand.runIfRequested()
        SliccstartApp.main()
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
    @StateObject private var appUpdater = AppUpdater(
        owner: "ai-ecoverse",
        repo: "slicc",
        releasePrefix: "Sliccstart",
        provider: TolerantGithubReleaseProvider(host: UpdateHostConfiguration.resolve())
    )
    @State private var smoothUpdater = SmoothUpdateCoordinator()
    private let updateHost = UpdateHostConfiguration.resolve()
    private let runtimeRefreshTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    private let optelAppID = Bundle.main.bundleIdentifier ?? "unknown.app"

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private var sliccProcess: SliccProcess { appDelegate.sliccProcess }

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
                        appManagementPermission: appManagementPermission,
                        appUpdater: appUpdater,
                        smoothUpdater: smoothUpdater,
                        onLaunchStandalone: { target in
                            log.info("onLaunchStandalone: \(target.name, privacy: .public)")
                            do {
                                try sliccProcess.launchStandalone(target)
                            } catch {
                                log.error("onLaunchStandalone failed: \(error.localizedDescription, privacy: .public)")
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
                        onCheckSmoothUpdate: { Task { await checkSmoothUpdate() } },
                        onApplySmoothUpdate: { version, assetURL, hash in
                            Task { await applySmoothUpdate(version: version, assetURL: assetURL, hash: hash) }
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
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                guard isReady else { return }
                sliccProcess.refreshRuntimeStates(for: targets)
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
                    Text("\(target.name) has remote debugging disabled.\n\nCreate a debug build in ~/Applications that enables SLICC to connect?\n\nThis will:\n• Copy the app to ~/Applications/\(target.name) Debug.app\n• Patch Electron fuses\n• Bypass CDP auth checks\n• Ad-hoc sign the result")
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
                    Text("\(target.name) is already running without a known SLICC debug port.\n\nSliccstart can quit and reopen it with remote debugging enabled.")
                }
            }
        }
        .defaultSize(width: 340, height: 100)
        .windowStyle(.titleBar)
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") {
                    appUpdater.check()
                    Task { await checkSmoothUpdate() }
                }
            }
        }

        Settings {
            SettingsView()
        }
    }

    private func initialize() async {
        let sliccDir = sliccProcess.resolvedSliccDir
        let status = SliccBootstrapper.checkInstallation(sliccDir: sliccDir)
        if status != .installed && status != .needsBuild {
            do {
                try await bootstrapper.bootstrap()
            } catch {
                bootstrapper.lastError = error.localizedDescription
                bootstrapper.progressMessage = error.localizedDescription
                return
            }
        }

        // Wire any active webapp overlay (Phase C) BEFORE we reattach or
        // spawn anything. New slicc-servers will pick up --static-root.
        let overlayStore = WebappOverlayStore()
        sliccProcess.uiOverlayRoot = overlayStore.activeOverlayPath()

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
            appUpdater.check()
            await checkSmoothUpdate()
        }

        // Skip the configured-browser auto-launch when we just reattached —
        // the user's previous session is already alive.
        if reattached.isEmpty {
            autoLaunchConfiguredBrowser()
        }
    }

    /// Launch the browser the user picked in Settings > Startup, if any.
    /// Stored as the `AppTarget.id` (bundle path) under
    /// `autoLaunchAppIdKey`. Failures are logged but never block startup.
    private func autoLaunchConfiguredBrowser() {
        let savedId = UserDefaults.standard.string(forKey: autoLaunchAppIdKey) ?? ""
        guard !savedId.isEmpty else { return }
        guard let target = targets.first(where: { $0.id == savedId && $0.type == .chromiumBrowser }) else {
            log.info("autoLaunch: no matching browser found for id=\(savedId, privacy: .public)")
            return
        }
        log.info("autoLaunch: launching \(target.name, privacy: .public)")
        do {
            try sliccProcess.launchStandalone(target)
        } catch {
            log.error("autoLaunch failed: \(error.localizedDescription, privacy: .public)")
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
            showError(error.localizedDescription)
        }
    }

    private func showError(_ message: String) {
        alertMessage = message
        showAlert = true
    }

    /// Look up the latest release's manifest and decide whether the upgrade
    /// path is webapp-only or full. Called periodically from the app menu
    /// command and once on initialize when bundled.
    private func checkSmoothUpdate() async {
        let resolver = ReleaseAssetResolver(
            host: updateHost,
            download: { url in
                var request = URLRequest(url: url)
                request.timeoutInterval = 10
                if let token = ProcessInfo.processInfo.environment["GH_TOKEN"], !token.isEmpty {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                return data
            }
        )
        do {
            guard let locator = try await resolver.resolveLatest(
                owner: "ai-ecoverse",
                repo: "slicc",
                releasePrefix: "Sliccstart"
            ) else {
                log.info("checkSmoothUpdate: no matching release with manifest assets yet")
                return
            }
            await smoothUpdater.check(
                manifestURL: locator.manifestURL,
                webappAssetURL: locator.webappAssetURL
            )
        } catch {
            log.error("checkSmoothUpdate: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func applySmoothUpdate(version: String, assetURL: URL, hash: String) async {
        await smoothUpdater.applyWebappOnly(
            version: version,
            assetURL: assetURL,
            manifestWebappHash: hash,
            respawn: {
                // Point new spawns at the new overlay, then restart every
                // existing slicc-server in-place. Browsers stay alive.
                sliccProcess.uiOverlayRoot = WebappOverlayStore().activeOverlayPath()
                await sliccProcess.respawnAllForOverlayChange()
            }
        )
    }
}
