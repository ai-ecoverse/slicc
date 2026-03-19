import Foundation

@Observable
final class SliccProcess {
    private var process: Process?
    private(set) var isRunning = false
    private(set) var target: AppTarget?

    private var sliccDir: String { SliccBootstrapper.defaultSliccDir }

    func launchWithBrowser(_ browser: AppTarget) throws {
        guard !isRunning else { return }
        target = browser
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [sliccDir + "/dist/cli/index.js", "--cdp-port=9222"]
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "CHROME_PATH": browser.executablePath,
            "PORT": "5710",
        ]) { _, new in new }
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.markStopped() }
        }

        try proc.run()
        process = proc
        isRunning = true
    }

    func launchWithElectronApp(_ app: AppTarget) throws {
        guard !isRunning else { return }
        target = app
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [
            sliccDir + "/dist/cli/index.js",
            "--electron", app.path,
            "--kill",
            "--cdp-port=9223",
        ]
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "PORT": "5710",
        ]) { _, new in new }
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.markStopped() }
        }

        try proc.run()
        process = proc
        isRunning = true
    }

    func installExtension(_ browser: AppTarget) throws {
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [
            sliccDir + "/dist/cli/install-extension.js",
            "--chrome-path=\(browser.executablePath)",
            "--extension-path=\(sliccDir)/dist/extension",
        ]
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)
        try proc.run()
        proc.waitUntilExit()

        if proc.terminationStatus != 0 {
            throw LaunchError.extensionInstallFailed
        }
    }

    func stop() {
        process?.terminate()
        markStopped()
    }

    private func markStopped() {
        isRunning = false
        target = nil
        process = nil
    }

    enum LaunchError: LocalizedError {
        case nodeNotFound
        case extensionInstallFailed
        var errorDescription: String? {
            switch self {
            case .nodeNotFound: return "Node.js not found"
            case .extensionInstallFailed: return "Extension installation failed"
            }
        }
    }
}
