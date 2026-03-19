import Foundation
import AppKit

@Observable
final class SliccProcess {
    private var process: Process?
    private(set) var isRunning = false
    private(set) var target: AppTarget?

    /// Resolve SLICC directory: check SLICC_DIR env, then parent of sliccstart, then default ~/.slicc/slicc
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

    /// Persistent SLICC Chrome profile — extension survives across launches.
    private var sliccChromeProfile: String {
        NSHomeDirectory() + "/.slicc/chrome-profile"
    }

    /// Check if the extension is already installed in the SLICC Chrome profile.
    private var extensionInstalledInProfile: Bool {
        let extensionsDir = sliccChromeProfile + "/Default/Extensions"
        guard let contents = try? FileManager.default.contentsOfDirectory(atPath: extensionsDir) else {
            return false
        }
        return !contents.isEmpty
    }

    // MARK: - Launch browser with SLICC profile

    /// Launch a Chromium browser with the persistent SLICC profile.
    /// Auto-installs the extension on first launch via CDP pipe.
    func launchWithBrowser(_ browser: AppTarget) throws {
        guard !isRunning else { return }
        target = browser
        guard let nodePath = SliccBootstrapper.findNode() else {
            throw LaunchError.nodeNotFound
        }

        // On first launch, install the extension into the SLICC profile
        if !extensionInstalledInProfile {
            try installExtensionToSliccProfile(browser)
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [sliccDir + "/dist/cli/index.js", "--cdp-port=9222"]
        // Set TMPDIR so the CLI server creates a persistent Chrome profile at ~/.slicc/
        // instead of /tmp/ (survives reboots, extension persists)
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "CHROME_PATH": browser.executablePath,
            "PORT": "5710",
            "TMPDIR": NSHomeDirectory() + "/.slicc",
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

    // MARK: - Launch Electron app

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

    // MARK: - Extension install (CDP pipe to SLICC profile)

    /// Install extension into the persistent SLICC Chrome profile via CDP pipe.
    private func installExtensionToSliccProfile(_ browser: AppTarget) throws {
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

    // MARK: - Guided install to default Chrome profile

    /// Copy extension to stable path and open chrome://extensions with instructions.
    func guidedInstallToDefaultChrome() throws {
        let stablePath = NSHomeDirectory() + "/.slicc/extension"
        let sourcePath = sliccDir + "/dist/extension"

        // Copy extension to stable path
        let fm = FileManager.default
        if fm.fileExists(atPath: stablePath) {
            try fm.removeItem(atPath: stablePath)
        }
        try fm.copyItem(atPath: sourcePath, toPath: stablePath)

        // Copy the path to clipboard
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(stablePath, forType: .string)

        // Open chrome://extensions in the default browser
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
