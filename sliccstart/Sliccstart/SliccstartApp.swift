import SwiftUI

@main
struct SliccstartApp: App {
    @State private var bootstrapper = SliccBootstrapper()
    @State private var sliccProcess = SliccProcess()
    @State private var targets: [AppTarget] = []
    @State private var isReady = false

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
                        onLaunchBrowser: { target in
                            sliccProcess.stop()
                            try? sliccProcess.launchWithBrowser(target)
                        },
                        onLaunchElectron: { target in
                            sliccProcess.stop()
                            try? sliccProcess.launchWithElectronApp(target)
                        },
                        onInstallExtension: { target in
                            Task.detached {
                                try? sliccProcess.installExtension(target)
                            }
                        },
                        onUpdate: {
                            Task {
                                isReady = false
                                try? await bootstrapper.update()
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
        }
        .windowStyle(.titleBar)
        .windowResizability(.contentMinSize)
    }

    private func initialize() async {
        let status = SliccBootstrapper.checkInstallation()
        if status != .installed {
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
}
