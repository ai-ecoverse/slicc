import Foundation
import AppKit
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "SliccProcess")

@Observable
final class SliccProcess {
    struct LaunchConfiguration: Equatable {
        let executablePath: String
        let arguments: [String]
        let logLabel: String
    }

    /// All running instances keyed by AppTarget.id
    private var processes: [String: Process] = [:]
    /// App paths launched via --electron, keyed by AppTarget.id
    private var launchedAppPaths: [String: String] = [:]
    private(set) var runningTargets: Set<String> = []

    var resolvedSliccDir: String { sliccDir }
    private var sliccDir: String {
        // Priority 1: SLICC_DIR env var (development override)
        if let env = ProcessInfo.processInfo.environment["SLICC_DIR"], !env.isEmpty {
            log.info("sliccDir: using SLICC_DIR env = \(env, privacy: .public)")
            return env
        }
        // Priority 2: Bundled inside the .app (production)
        if let bundled = SliccBootstrapper.bundledSliccDir {
            log.info("sliccDir: using bundled = \(bundled, privacy: .public)")
            return bundled
        }
        // Priority 3: Walk up from bundle location (development — running from source tree)
        let parentDir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        var dir = parentDir
        for _ in 0..<5 {
            if FileManager.default.fileExists(atPath: dir + "/package.json") &&
               FileManager.default.fileExists(atPath: dir + "/packages/node-server/src/index.ts") {
                log.info("sliccDir: found source tree at \(dir, privacy: .public)")
                return dir
            }
            dir = (dir as NSString).deletingLastPathComponent
        }
        log.warning("sliccDir: falling back to default \(SliccBootstrapper.defaultSliccDir)")
        return SliccBootstrapper.defaultSliccDir
    }

    /// Port allocation: browser gets 5710, electron apps get 5711, 5712, ...
    /// CDP ports: browser gets 9222, electron apps get 9223, 9224, ...
    private static let browserPort: UInt16 = 5710
    private static let browserCdpPort: UInt16 = 9222
    private static let electronBasePort: UInt16 = 5711
    private static let electronBaseCdpPort: UInt16 = 9223

    func isRunning(_ target: AppTarget) -> Bool {
        runningTargets.contains(target.id)
    }

    // MARK: - Browser mode

    func launchStandalone(_ browser: AppTarget) throws {
        if isRunning(browser) {
            log.info("launchStandalone: \(browser.name) already running")
            return
        }
        guard !Self.isPortInUse(Self.browserPort) else { throw LaunchError.portInUse(Self.browserPort) }
        log.info("launchStandalone: \(browser.name, privacy: .public) on port \(Self.browserPort)")
        try spawn(target: browser, extraArgs: ["--cdp-port=\(Self.browserCdpPort)"], env: [
            "CHROME_PATH": browser.executablePath,
            "PORT": "\(Self.browserPort)",
        ])
    }

    // MARK: - WebKit mode

    func launchWebKit(binaryPath: String, frameworkPath: String) throws {
        let webkitId = "webkit-browser"
        if runningTargets.contains(webkitId) {
            log.info("launchWebKit: already running")
            return
        }
        guard !Self.isPortInUse(Self.browserPort) else { throw LaunchError.portInUse(Self.browserPort) }
        log.info("launchWebKit: launching on port \(Self.browserPort)")

        let icon = NSWorkspace.shared.icon(forFile: binaryPath)
        let target = AppTarget(
            id: webkitId, name: "WebKit", path: binaryPath,
            executablePath: binaryPath,
            type: .webkitBrowser, icon: icon,
            debugSupport: .supported,
            isDebugBuild: false,
            originalAppPath: nil
        )

        // Intentionally do NOT pass DYLD_FRAMEWORK_PATH / DYLD_LIBRARY_PATH
        // here. WebKitManager exposes the install root, but Playwright's
        // dylibs actually live under `Playwright.app/Contents/Frameworks`.
        // Pointing DYLD_* at the install root breaks WebKit startup. The
        // server (`WebKitLauncher.resolveFrameworkPath(binaryPath:)`)
        // computes the correct frameworks dir from the binary path, so we
        // just hand it WEBKIT_PATH and let it resolve the rest.
        _ = frameworkPath  // Reserved for future use; kept in the API for callers.
        try spawn(target: target, extraArgs: [
            "--browser=webkit",
            "--cdp-port=\(Self.browserCdpPort)",
        ], env: [
            "WEBKIT_PATH": binaryPath,
            "PORT": "\(Self.browserPort)",
        ])
    }

    // MARK: - Electron mode (each app gets its own port)

    func launchWithElectronApp(_ app: AppTarget) throws {
        if isRunning(app) {
            log.info("launchWithElectronApp: \(app.name) already running")
            return
        }
        let (port, cdpPort) = nextElectronPorts()
        guard !Self.isPortInUse(port) else { throw LaunchError.portInUse(port) }
        log.info("launchWithElectronApp: \(app.name, privacy: .public) on port \(port), cdp \(cdpPort)")
        launchedAppPaths[app.id] = app.path
        try spawn(target: app, extraArgs: [
            "--electron-app=\(app.path)",
            "--kill",
            "--cdp-port=\(cdpPort)",
        ], env: ["PORT": "\(port)"])
    }

    /// Find the next available port pair for an Electron app.
    private func nextElectronPorts() -> (port: UInt16, cdpPort: UInt16) {
        let electronCount = UInt16(processes.count) // offset from base
        for i: UInt16 in 0...20 {
            let port = Self.electronBasePort + electronCount + i
            let cdpPort = Self.electronBaseCdpPort + electronCount + i
            if !Self.isPortInUse(port) && !Self.isPortInUse(cdpPort) {
                return (port, cdpPort)
            }
        }
        // Fallback — try anyway
        let port = Self.electronBasePort + electronCount
        return (port, Self.electronBaseCdpPort + electronCount)
    }

    // MARK: - Chrome Web Store

    static let chromeWebStoreURL = "https://chromewebstore.google.com/detail/slicc/akjjllgokmbgpbdbmafpiefnhidlmbgf"

    func openChromeWebStore() {
        guard let url = URL(string: Self.chromeWebStoreURL) else { return }
        if let chromeURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
            log.info("openChromeWebStore: opening in Chrome")
            NSWorkspace.shared.open([url], withApplicationAt: chromeURL, configuration: NSWorkspace.OpenConfiguration())
        } else {
            log.warning("openChromeWebStore: Chrome not found, opening in default browser")
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Lifecycle

    func stop(_ target: AppTarget) {
        log.info("stop: \(target.name)")
        processes[target.id]?.terminate()
        processes.removeValue(forKey: target.id)
        terminateLaunchedApp(id: target.id)
        runningTargets.remove(target.id)
    }

    func stopAll() {
        log.info("stopAll: terminating \(self.processes.count) processes")
        for (_, proc) in processes { proc.terminate() }
        processes.removeAll()
        for (id, _) in launchedAppPaths {
            terminateLaunchedApp(id: id)
        }
        runningTargets.removeAll()
    }

    /// Terminate a launched Electron/WebView2 app by its bundle path.
    private func terminateLaunchedApp(id: String) {
        guard let appPath = launchedAppPaths.removeValue(forKey: id) else { return }
        let appURL = URL(fileURLWithPath: appPath)
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleURL == appURL }
        for app in running {
            log.info("terminating app: \(app.localizedName ?? appPath, privacy: .public)")
            app.terminate()
        }
    }

    // MARK: - Private

    static func resolveLaunchConfiguration(
        sliccDir: String,
        extraArgs: [String],
        resourcePath: String? = Bundle.main.resourcePath
    ) throws -> LaunchConfiguration {
        if let serverBinary = SliccBootstrapper.findServerBinary(
            sliccDir: sliccDir,
            resourcePath: resourcePath
        ) {
            return LaunchConfiguration(
                executablePath: serverBinary,
                arguments: extraArgs,
                logLabel: "server"
            )
        }

        log.error("resolveLaunchConfiguration: slicc-server binary not found")
        throw LaunchError.serverBinaryNotFound
    }

    private func spawn(target: AppTarget, extraArgs: [String], env: [String: String]) throws {
        let launchConfig = try Self.resolveLaunchConfiguration(sliccDir: sliccDir, extraArgs: extraArgs)
        log.info("spawn: \(launchConfig.executablePath, privacy: .public) \(launchConfig.arguments.joined(separator: " "), privacy: .public)")
        log.info("spawn: cwd = \(self.sliccDir, privacy: .public)")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchConfig.executablePath)
        proc.arguments = launchConfig.arguments
        proc.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }
        proc.currentDirectoryURL = URL(fileURLWithPath: sliccDir)

        // Capture stdout/stderr and forward to os.log
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            for l in line.split(separator: "\n", omittingEmptySubsequences: true) {
                log.info("[\(launchConfig.logLabel, privacy: .public)/\(target.name, privacy: .public)] \(l, privacy: .public)")
            }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            for l in line.split(separator: "\n", omittingEmptySubsequences: true) {
                log.error("[\(launchConfig.logLabel, privacy: .public)/\(target.name, privacy: .public)] \(l, privacy: .public)")
            }
        }

        proc.terminationHandler = { [weak self] p in
            log.info("process exited: \(target.name, privacy: .public) code=\(p.terminationStatus)")
            // Clean up pipe handlers
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                self?.processes.removeValue(forKey: target.id)
                self?.runningTargets.remove(target.id)
            }
        }
        try proc.run()
        log.info("spawn: pid=\(proc.processIdentifier) for \(target.name, privacy: .public)")
        processes[target.id] = proc
        runningTargets.insert(target.id)
    }

    private static func isPortInUse(_ port: UInt16) -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(sock, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    enum LaunchError: LocalizedError {
        case serverBinaryNotFound
        case portInUse(UInt16)
        var errorDescription: String? {
            switch self {
            case .serverBinaryNotFound: return "SLICC server binary not found. Build or bundle slicc-server before launching."
            case .portInUse(let port): return "Port \(port) is already in use."
            }
        }
    }
}
