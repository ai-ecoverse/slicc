import SwiftUI
import AppKit

@main
struct SliccstartApp: App {
    @State private var bootstrapper = SliccBootstrapper()
    @State private var sliccProcess = SliccProcess()
    @State private var appManagementPermission = AppManagementPermission()
    @State private var targets: [AppTarget] = []
    @State private var isReady = false
    @State private var alertMessage: String?
    @State private var showAlert = false
    @State private var showDebugBuildDialog = false
    @State private var debugBuildTarget: AppTarget?
    @State private var isCreatingDebugBuild = false
    @State private var debugBuildProgress: String = ""

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
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
                        appManagementPermission: appManagementPermission,
                        onLaunchStandalone: { target in
                            do {
                                try sliccProcess.launchStandalone(target)
                            } catch {
                                showError(error.localizedDescription)
                            }
                        },
                        onLaunchElectron: { target in
                            do {
                                try sliccProcess.launchWithElectronApp(target)
                            } catch {
                                showError(error.localizedDescription)
                            }
                        },
                        onGuidedInstall: { target in
                            do {
                                try sliccProcess.guidedInstallExtension(chromePath: target.executablePath)
                                showError(
                                    "Chrome and Finder are open.\n\n" +
                                    "In chrome://extensions:\n" +
                                    "1. Enable 'Developer mode' (top-right toggle)\n" +
                                    "2. Click 'Load unpacked'\n" +
                                    "3. Select the ~/.slicc/extension folder shown in Finder\n\n" +
                                    "Keep Developer Mode enabled — the extension needs it."
                                )
                            } catch {
                                showError("Failed: \(error.localizedDescription)")
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
                                targets = AppScanner.scan()
                                isReady = true
                            }
                        },
                        onRescan: { targets = AppScanner.scan() }
                    )
                }
            }
            .frame(width: 340)
            .task { await initialize() }
            .onAppear { appManagementPermission.startPolling() }
            .onDisappear {
                sliccProcess.stopAll()
                appManagementPermission.stopPolling()
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
        targets = AppScanner.scan()
        isReady = true
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
            targets = AppScanner.scan()
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
