import Foundation
import AppKit

@Observable
final class SliccProcess {
    private var process: Process?
    private(set) var isRunning = false
    private(set) var target: AppTarget?

    var resolvedSliccDir: String { sliccDir }
    private var sliccDir: String {
        if let env = ProcessInfo.processInfo.environment["SLICC_DIR"], !env.isEmpty {
            return env
        }
        let parentDir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        var dir = parentDir
        for _ in 0..<5 {
            if FileManager.default.fileExists(atPath: dir + "/package.json") &&
               FileManager.default.fileExists(atPath: dir + "/src/cli/index.ts") {
                return dir
            }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return SliccBootstrapper.defaultSliccDir
    }

    private var extensionInstalledInProfile: Bool {
        let extensionsDir = NSHomeDirectory() + "/.slicc/browser-coding-agent-chrome/Default/Extensions"
        guard let contents = try? FileManager.default.contentsOfDirectory(atPath: extensionsDir) else {
            return false
        }
        return !contents.isEmpty
    }

    // MARK: - Standalone mode (throwaway /tmp/ profile, no extension)

    func launchStandalone(_ browser: AppTarget) throws {
        guard !isRunning else { return }
        target = browser
        try spawnCLI(extraArgs: ["--cdp-port=9222"], env: [
            "CHROME_PATH": browser.executablePath,
            "PORT": "5710",
        ])
    }

    // MARK: - SLICC profile mode (persistent ~/.slicc/ profile, with extension)

    func launchWithExtension(_ browser: AppTarget) throws {
        guard !isRunning else { return }
        target = browser

        // Auto-install extension on first launch
        if !extensionInstalledInProfile {
            try installExtensionToProfile(browser)
        }

        try spawnCLI(extraArgs: ["--cdp-port=9222"], env: [
            "CHROME_PATH": browser.executablePath,
            "PORT": "5710",
            "TMPDIR": NSHomeDirectory() + "/.slicc",
        ])
    }

    // MARK: - Electron app

    func launchWithElectronApp(_ app: AppTarget) throws {
        guard !isRunning else { return }
        target = app
        try spawnCLI(extraArgs: [
            "--electron", app.path,
            "--kill",
            "--cdp-port=9223",
        ], env: ["PORT": "5710"])
    }

    // MARK: - Extension install (CDP pipe)

    private func installExtensionToProfile(_ browser: AppTarget) throws {
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
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try proc.run()
        proc.waitUntilExit()
        if proc.terminationStatus != 0 {
            throw LaunchError.extensionInstallFailed
        }
    }

    // MARK: - Guided install to default Chrome

    func guidedInstallToDefaultChrome() throws {
        let stablePath = NSHomeDirectory() + "/.slicc/extension"
        let sourcePath = sliccDir + "/dist/extension"
        let fm = FileManager.default
        if fm.fileExists(atPath: stablePath) {
            try fm.removeItem(atPath: stablePath)
        }
        try fm.copyItem(atPath: sourcePath, toPath: stablePath)

        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(stablePath, forType: .string)

        if let url = URL(string: "chrome://extensions") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Lifecycle

    func stop() {
        process?.terminate()
        markStopped()
    }

    private func markStopped() {
        isRunning = false
        target = nil
        process = nil
    }

    // MARK: - Private helpers

    private func spawnCLI(extraArgs: [String], env: [String: String]) throws {
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [sliccDir + "/dist/cli/index.js"] + extraArgs
        proc.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
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
