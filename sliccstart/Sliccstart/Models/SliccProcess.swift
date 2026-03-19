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

    // MARK: - Standalone mode (CLI server launches Chrome with temp profile)

    func launchStandalone(_ browser: AppTarget) throws {
        guard !isRunning else { return }
        target = browser
        try spawnCLI(extraArgs: ["--cdp-port=9222"], env: [
            "CHROME_PATH": browser.executablePath,
            "PORT": "5710",
        ])
    }

    // MARK: - Electron app (CLI server + overlay injection)

    func launchWithElectronApp(_ app: AppTarget) throws {
        guard !isRunning else { return }
        target = app
        try spawnCLI(extraArgs: [
            "--electron", app.path,
            "--kill",
            "--cdp-port=9223",
        ], env: ["PORT": "5710"])
    }

    // MARK: - Guided extension install

    /// Copy extension to a stable path, open Chrome to chrome://extensions,
    /// and open Finder at the extension folder so the user can select it.
    func guidedInstallExtension(chromePath: String) throws {
        let stablePath = NSHomeDirectory() + "/.slicc/extension"
        let sourcePath = sliccDir + "/dist/extension"
        let fm = FileManager.default

        // Copy extension to stable path
        if fm.fileExists(atPath: stablePath) {
            try fm.removeItem(atPath: stablePath)
        }
        try fm.copyItem(atPath: sourcePath, toPath: stablePath)

        // Open Chrome to chrome://extensions
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: chromePath)
        proc.arguments = ["chrome://extensions"]
        try proc.run()

        // Open Finder at the extension folder (user selects this in "Load unpacked")
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: stablePath)
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

    // MARK: - Private

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
        var errorDescription: String? {
            switch self {
            case .nodeNotFound: return "Node.js not found"
            }
        }
    }
}
