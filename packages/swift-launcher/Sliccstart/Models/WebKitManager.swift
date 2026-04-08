import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "WebKitManager")

enum WebKitInstallState: Equatable {
    case notInstalled
    case installing
    case installed(binaryPath: String, frameworkPath: String)
}

@Observable
final class WebKitManager {
    var installState: WebKitInstallState = .notInstalled
    var installProgress: String = ""

    /// The base directory where Playwright caches browsers
    private static var playwrightCacheDir: String {
        NSHomeDirectory() + "/Library/Caches/ms-playwright"
    }

    /// Check if Playwright's patched WebKit is installed and return its paths
    static func detectWebKit() -> WebKitInstallState {
        let fm = FileManager.default
        let cacheDir = playwrightCacheDir

        guard fm.fileExists(atPath: cacheDir) else {
            log.info("detectWebKit: playwright cache dir not found")
            return .notInstalled
        }

        // Look for webkit-* directories
        guard let contents = try? fm.contentsOfDirectory(atPath: cacheDir) else {
            return .notInstalled
        }

        // Find the latest webkit directory (sorted descending to get newest version)
        let webkitDirs = contents.filter { $0.hasPrefix("webkit-") }.sorted().reversed()

        for dir in webkitDirs {
            let webkitDir = "\(cacheDir)/\(dir)"
            let playwrightApp = "\(webkitDir)/Playwright.app"
            let binaryPath = "\(playwrightApp)/Contents/MacOS/Playwright"

            if fm.fileExists(atPath: binaryPath) {
                log.info("detectWebKit: found at \(webkitDir, privacy: .public)")
                return .installed(binaryPath: binaryPath, frameworkPath: webkitDir)
            }
        }

        log.info("detectWebKit: no Playwright.app found in webkit dirs")
        return .notInstalled
    }

    /// Refresh the install state by checking the filesystem
    func refresh() {
        if case .installing = installState { return }
        installState = Self.detectWebKit()
    }

    /// Install Playwright's patched WebKit via npx
    func install() async throws {
        guard case .notInstalled = installState else { return }

        installState = .installing
        installProgress = "Installing WebKit browser..."

        guard let npxPath = Self.findNpx() else {
            installState = .notInstalled
            throw WebKitError.npxNotFound
        }

        log.info("install: running npx playwright install webkit")
        installProgress = "Downloading WebKit..."

        let task = Process()
        task.executableURL = URL(fileURLWithPath: npxPath)
        task.arguments = ["playwright", "install", "webkit"]
        task.environment = Self.enrichedEnvironment

        let stderrPipe = Pipe()
        let stdoutPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = stderrPipe

        try task.run()
        task.waitUntilExit()

        guard task.terminationStatus == 0 else {
            let stderr = String(
                data: stderrPipe.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            log.error("install: npx playwright install webkit failed: \(stderr, privacy: .public)")
            installState = .notInstalled
            throw WebKitError.installFailed(stderr.isEmpty ? "Unknown error" : String(stderr.suffix(300)))
        }

        log.info("install: WebKit installed successfully")
        installProgress = "WebKit installed!"

        // Refresh to pick up the installed binary
        let detected = Self.detectWebKit()
        installState = detected

        guard case .installed = detected else {
            throw WebKitError.installFailed("Installation completed but WebKit binary not found")
        }
    }

    /// Whether WebKit is ready to launch
    var isInstalled: Bool {
        if case .installed = installState { return true }
        return false
    }

    /// Whether an install is in progress
    var isInstalling: Bool {
        if case .installing = installState { return true }
        return false
    }

    private static func findNpx() -> String? {
        // Check common locations
        for candidate in [
            "/usr/local/bin/npx",
            "/opt/homebrew/bin/npx",
            NSHomeDirectory() + "/.nvm/current/bin/npx",
        ] {
            if FileManager.default.fileExists(atPath: candidate) { return candidate }
        }
        // Try which
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        task.arguments = ["npx"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return output.isEmpty ? nil : output
    }

    private static var enrichedEnvironment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extraPaths = [
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
            NSHomeDirectory() + "/.nvm/current/bin",
        ]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        let allPaths = extraPaths + currentPath.split(separator: ":").map(String.init)
        env["PATH"] = Array(Set(allPaths)).joined(separator: ":")
        return env
    }

    enum WebKitError: LocalizedError {
        case npxNotFound
        case installFailed(String)
        var errorDescription: String? {
            switch self {
            case .npxNotFound:
                return "npx not found. Install Node.js from https://nodejs.org to install WebKit."
            case .installFailed(let detail):
                return "WebKit installation failed: \(detail)"
            }
        }
    }
}

