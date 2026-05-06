import SwiftUI
import AppKit
import os
import AppUpdater

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "App")

/// Delegate that terminates all launched SLICC processes when the app quits.
/// Owns the long-lived process / download instances so they stay alive for
/// the entire app lifetime — Settings views are recreated on every open
/// and would otherwise orphan child processes or cancel downloads.
final class SliccstartAppDelegate: NSObject, NSApplicationDelegate {
    let sliccProcess = SliccProcess()
    let swiftLMProcess = SwiftLMProcess()

    @MainActor
    let modelDownloads = ModelDownloadManager()

    func applicationWillTerminate(_ notification: Notification) {
        log.info("applicationWillTerminate: stopping all processes")
        sliccProcess.stopAll()
        swiftLMProcess.stop()
    }
}

@main
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
    @State private var isCreatingDebugBuild = false
    @State private var debugBuildProgress: String = ""
    @StateObject private var appUpdater = AppUpdater(owner: "ai-ecoverse", repo: "slicc", releasePrefix: "Sliccstart", provider: TolerantGithubReleaseProvider())

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private var sliccProcess: SliccProcess { appDelegate.sliccProcess }
    private var swiftLMProcess: SwiftLMProcess { appDelegate.swiftLMProcess }
    private var modelDownloads: ModelDownloadManager { appDelegate.modelDownloads }

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
                            do {
                                try sliccProcess.launchWithElectronApp(target)
                            } catch {
                                log.error("onLaunchElectron failed: \(error.localizedDescription, privacy: .public)")
                                showError(error.localizedDescription)
                            }
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
                        onRescan: { targets = AppScanner.scan(hasAppManagementPermission: appManagementPermission.isGranted) }
                    )
                }
            }
            .frame(width: 340)
            .task { await initialize() }
            .onAppear { appManagementPermission.startWatchingForGrant() }
            .onDisappear { appManagementPermission.stopWatchingForGrant() }
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
        }
        .defaultSize(width: 340, height: 100)
        .windowStyle(.titleBar)
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") {
                    appUpdater.check()
                }
            }
        }

        Settings {
            SettingsView()
                .environment(swiftLMProcess)
                .environment(modelDownloads)
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
        targets = AppScanner.scan(hasAppManagementPermission: appManagementPermission.isGranted)
        isReady = true

        // Check for app updates in bundled mode
        if SliccBootstrapper.isBundled {
            appUpdater.check()
        }

        autoLaunchConfiguredBrowser()
        autoRunConfiguredLocalModel()
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

    /// Start the local LLM the user pinned in Settings > Models, if any.
    /// Stored as a HuggingFace `repoId` under `autoRunModelIdKey`. Skipped
    /// silently when:
    ///   - the Models tab is hidden on this hardware (<64 GB RAM); the
    ///     setting can't have come from this install, but a defensive
    ///     no-op keeps a synced UserDefaults blob from triggering an
    ///     auto-start on a laptop that can't run the model.
    ///   - the saved model isn't in the HF cache anymore; auto-run must
    ///     not block launch behind a multi-GB download or a `start()`
    ///     that would error out on a missing snapshot.
    /// `swiftLM.start(model:)` is async and may take seconds (model load)
    /// or longer (first-launch SwiftLM tarball download); it runs detached
    /// so the launcher window paints immediately.
    private func autoRunConfiguredLocalModel() {
        guard LocalModelsAvailability.isSupported else { return }
        let savedId = UserDefaults.standard.string(forKey: autoRunModelIdKey) ?? ""
        guard !savedId.isEmpty else { return }
        let installed = HFCache.listInstalledMLXModels().map { $0.repoId }
        guard installed.contains(savedId) else {
            log.info("autoRun: configured model \(savedId, privacy: .public) not installed — skipping")
            return
        }
        log.info("autoRun: starting \(savedId, privacy: .public)")
        Task {
            do {
                try await swiftLMProcess.start(model: savedId)
            } catch {
                log.error("autoRun failed: \(error.localizedDescription, privacy: .public)")
            }
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

    private func showError(_ message: String) {
        alertMessage = message
        showAlert = true
    }
}
