import SwiftUI
import AppKit

@main
struct SliccstartApp: App {
    @State private var bootstrapper = SliccBootstrapper()
    @State private var sliccProcess = SliccProcess()
    @State private var targets: [AppTarget] = []
    @State private var isReady = false
    @State private var alertMessage: String?
    @State private var showAlert = false

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)

        if let iconPath = Self.findSliccIcon() {
            NSApplication.shared.applicationIconImage = NSImage(contentsOfFile: iconPath)
        }
    }

    private static func findSliccIcon() -> String? {
        var dir = Bundle.main.bundlePath
        for _ in 0..<6 {
            dir = (dir as NSString).deletingLastPathComponent
            let candidate = dir + "/logos/slicc-favicon-128.png"
            if FileManager.default.fileExists(atPath: candidate) { return candidate }
        }
        return nil
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
                } else {
                    AppListView(
                        targets: targets,
                        sliccProcess: sliccProcess,
                        onLaunchStandalone: { target in
                            sliccProcess.stop()
                            do {
                                try sliccProcess.launchStandalone(target)
                            } catch {
                                showError("Failed to launch: \(error.localizedDescription)")
                            }
                        },
                        onLaunchElectron: { target in
                            sliccProcess.stop()
                            do {
                                try sliccProcess.launchWithElectronApp(target)
                            } catch {
                                showError("Failed to launch: \(error.localizedDescription)")
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
            .frame(width: 420)
            .frame(minHeight: 400)
            .task { await initialize() }
            .onDisappear { sliccProcess.stop() }
            .alert("Sliccstart", isPresented: $showAlert) {
                Button("OK") {}
            } message: {
                Text(alertMessage ?? "")
            }
        }
        .windowStyle(.titleBar)
        .windowResizability(.contentMinSize)
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

    private func showError(_ message: String) {
        alertMessage = message
        showAlert = true
    }
}
