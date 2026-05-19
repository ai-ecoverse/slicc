import Foundation
import AppKit
import Darwin
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "SliccProcess")

enum AppStartBlocker: Equatable {
    case needsPermission
    case needsDebugBuild
}

enum AppRuntimeState: Equatable {
    case notRunning
    case runningWithoutDebug
    case runningWithDebug(cdpPort: UInt16?)
    case startFailed(message: String)
    case cannotStart(AppStartBlocker)

    var isRunning: Bool {
        switch self {
        case .runningWithoutDebug, .runningWithDebug:
            return true
        case .notRunning, .startFailed, .cannotStart:
            return false
        }
    }

    static func resolve(
        targetType: AppTargetType,
        debugSupport: ElectronDebugSupport = .supported,
        hasAppManagementPermission: Bool = true,
        debugPort: UInt16? = nil,
        launchFailure: String? = nil,
        appIsRunning: Bool = false
    ) -> AppRuntimeState {
        if targetType == .electronApp {
            if !hasAppManagementPermission {
                return .cannotStart(.needsPermission)
            }
            if debugSupport == .disabled {
                return .cannotStart(.needsDebugBuild)
            }
        }

        if debugPort != nil {
            return .runningWithDebug(cdpPort: debugPort)
        }
        if targetType == .electronApp && appIsRunning {
            return .runningWithoutDebug
        }
        if let launchFailure {
            return .startFailed(message: launchFailure)
        }
        return .notRunning
    }
}

@Observable
final class SliccProcess {
    struct LaunchConfiguration: Equatable {
        let executablePath: String
        let arguments: [String]
        let logLabel: String
    }

    private struct LaunchRecord {
        let process: Process
        let targetType: AppTargetType
        let launchedAppPaths: [String]
        let cdpPort: UInt16
        let startedAt: Date
        var observedAppPID: pid_t?
    }

    /// SLICC helper/server processes keyed by AppTarget.id.
    private var launchRecords: [String: LaunchRecord] = [:]
    private var startFailures: [String: String] = [:]
    private var intentionallyStoppingTargets: Set<String> = []

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
    private static let electronLaunchStaleTimeout: TimeInterval = 30

    func isRunning(_ target: AppTarget) -> Bool {
        runtimeState(for: target).isRunning
    }

    func runtimeState(
        for target: AppTarget,
        hasAppManagementPermission: Bool = true
    ) -> AppRuntimeState {
        let debugPort = activeDebugPort(for: target)
        let appIsRunning = target.type == .electronApp && isElectronAppRunning(target)
        return AppRuntimeState.resolve(
            targetType: target.type,
            debugSupport: target.debugSupport,
            hasAppManagementPermission: hasAppManagementPermission,
            debugPort: debugPort,
            launchFailure: startFailures[target.id],
            appIsRunning: appIsRunning
        )
    }

    func refreshRuntimeStates(for targets: [AppTarget]) {
        for target in targets {
            refreshRuntimeState(for: target)
        }
    }

    // MARK: - Browser mode

    func launchStandalone(_ browser: AppTarget) throws {
        refreshRuntimeState(for: browser)
        if isRunning(browser) {
            log.info("launchStandalone: \(browser.name) already running")
            return
        }
        startFailures.removeValue(forKey: browser.id)
        guard !Self.isPortInUse(Self.browserPort) else { throw LaunchError.portInUse(Self.browserPort) }
        log.info("launchStandalone: \(browser.name, privacy: .public) on port \(Self.browserPort)")
        do {
            try spawn(
                target: browser,
                extraArgs: ["--cdp-port=\(Self.browserCdpPort)"],
                env: [
                    "CHROME_PATH": browser.executablePath,
                    "PORT": "\(Self.browserPort)",
                ],
                cdpPort: Self.browserCdpPort
            )
        } catch {
            recordStartFailure(for: browser, message: error.localizedDescription)
            throw error
        }
    }

    // MARK: - Electron mode (each app gets its own port)

    func launchWithElectronApp(_ app: AppTarget, forceRestartExistingApp: Bool = false) throws {
        refreshRuntimeState(for: app)
        if isRunning(app) {
            if case .runningWithDebug = runtimeState(for: app) {
                log.info("launchWithElectronApp: \(app.name) already running with SLICC")
                return
            }
        }
        if forceRestartExistingApp {
            terminateElectronApplications(atAppPaths: Self.relatedAppPaths(for: app))
        }
        startFailures.removeValue(forKey: app.id)
        let (port, cdpPort) = nextElectronPorts()
        guard !Self.isPortInUse(port) else { throw LaunchError.portInUse(port) }
        log.info("launchWithElectronApp: \(app.name, privacy: .public) on port \(port), cdp \(cdpPort)")
        do {
            try spawn(
                target: app,
                extraArgs: [
                    "--electron-app=\(app.path)",
                    "--kill",
                    "--cdp-port=\(cdpPort)",
                ],
                env: ["PORT": "\(port)"],
                cdpPort: cdpPort
            )
        } catch {
            recordStartFailure(for: app, message: error.localizedDescription)
            throw error
        }
    }

    /// Find the next available port pair for an Electron app.
    private func nextElectronPorts() -> (port: UInt16, cdpPort: UInt16) {
        let electronCount = UInt16(launchRecords.count) // offset from base
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
        stopLaunchRecord(id: target.id, terminateApps: true)
        startFailures.removeValue(forKey: target.id)
    }

    func stopAll() {
        log.info("stopAll: terminating \(self.launchRecords.count) processes")
        for id in Array(launchRecords.keys) {
            stopLaunchRecord(id: id, terminateApps: true)
        }
        startFailures.removeAll()
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

    private func spawn(
        target: AppTarget,
        extraArgs: [String],
        env: [String: String],
        cdpPort: UInt16
    ) throws {
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
                guard let self else { return }
                let wasIntentional = self.intentionallyStoppingTargets.remove(target.id) != nil
                let isCurrentRecord = self.launchRecords[target.id]?.process === p
                if isCurrentRecord {
                    self.launchRecords.removeValue(forKey: target.id)
                }
                if !wasIntentional && p.terminationStatus != 0 && isCurrentRecord {
                    self.recordStartFailure(
                        for: target,
                        message: "SLICC exited with code \(p.terminationStatus)."
                    )
                }
            }
        }
        try proc.run()
        log.info("spawn: pid=\(proc.processIdentifier) for \(target.name, privacy: .public)")
        launchRecords[target.id] = LaunchRecord(
            process: proc,
            targetType: target.type,
            launchedAppPaths: target.type == .electronApp ? Self.launchedAppPaths(for: target) : [],
            cdpPort: cdpPort,
            startedAt: Date(),
            observedAppPID: nil
        )
    }

    private func refreshRuntimeState(for target: AppTarget) {
        guard var record = launchRecords[target.id] else { return }
        guard record.process.isRunning else {
            launchRecords.removeValue(forKey: target.id)
            return
        }

        guard record.targetType == .electronApp else {
            return
        }

        let runningApps = runningElectronApplications(for: target)
        if let app = runningApps.first {
            record.observedAppPID = app.processIdentifier
            launchRecords[target.id] = record
            return
        }

        guard let observedAppPID = record.observedAppPID else {
            if Date().timeIntervalSince(record.startedAt) > Self.electronLaunchStaleTimeout,
               !Self.isPortInUse(record.cdpPort) {
                log.info("refreshRuntimeState: \(target.name, privacy: .public) has no app pid or CDP listener; stopping stale helper")
                stopLaunchRecord(id: target.id, terminateApps: false)
                return
            }
            return
        }

        if !Self.isPIDRunning(observedAppPID) {
            log.info("refreshRuntimeState: \(target.name, privacy: .public) app pid \(observedAppPID) exited; stopping helper")
            stopLaunchRecord(id: target.id, terminateApps: false)
        }
    }

    private func activeDebugPort(for target: AppTarget) -> UInt16? {
        guard let record = launchRecords[target.id], record.process.isRunning else {
            return nil
        }
        if record.targetType == .electronApp,
           !Self.isPortInUse(record.cdpPort) {
            return nil
        }
        if record.targetType == .electronApp,
           let observedAppPID = record.observedAppPID,
           !Self.isPIDRunning(observedAppPID),
           !isElectronAppRunning(target) {
            return nil
        }
        return record.cdpPort
    }

    private func stopLaunchRecord(id: String, terminateApps: Bool) {
        guard let record = launchRecords.removeValue(forKey: id) else {
            intentionallyStoppingTargets.remove(id)
            return
        }

        intentionallyStoppingTargets.insert(id)
        if terminateApps {
            terminateElectronApplications(atAppPaths: record.launchedAppPaths)
        }
        if record.process.isRunning {
            record.process.terminate()
        } else {
            intentionallyStoppingTargets.remove(id)
        }
    }

    private func recordStartFailure(for target: AppTarget, message: String) {
        startFailures[target.id] = message
    }

    private func isElectronAppRunning(_ target: AppTarget) -> Bool {
        !runningElectronApplications(for: target).isEmpty
    }

    private func runningElectronApplications(for target: AppTarget) -> [NSRunningApplication] {
        Self.runningElectronApplications(atAppPaths: Self.relatedAppPaths(for: target))
    }

    private func terminateElectronApplications(atAppPaths appPaths: [String]) {
        for app in Self.runningElectronApplications(atAppPaths: appPaths) {
            log.info("terminating app: \(app.localizedName ?? app.bundleURL?.path ?? "unknown", privacy: .public)")
            app.terminate()
        }
    }

    static func launchedAppPaths(for target: AppTarget) -> [String] {
        [target.path]
    }

    static func relatedAppPaths(for target: AppTarget) -> [String] {
        var paths = [target.path]
        if let originalAppPath = target.originalAppPath, originalAppPath != target.path {
            paths.append(originalAppPath)
        }
        return paths
    }

    private static func runningElectronApplications(atAppPaths appPaths: [String]) -> [NSRunningApplication] {
        let appURLs = Set(appPaths.map { standardizedFileURL(path: $0) })
        return NSWorkspace.shared.runningApplications.filter { app in
            guard !app.isTerminated else { return false }
            if let bundleURL = app.bundleURL.map({ standardizedFileURL(path: $0.path) }),
               appURLs.contains(bundleURL) {
                return true
            }
            if let executableURL = app.executableURL?.standardizedFileURL.resolvingSymlinksInPath() {
                return appURLs.contains { appURL in
                    executableURL.path.hasPrefix(appURL.appendingPathComponent("Contents/MacOS").path)
                }
            }
            return false
        }
    }

    private static func standardizedFileURL(path: String) -> URL {
        URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
            .standardizedFileURL
            .resolvingSymlinksInPath()
    }

    private static func isPIDRunning(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) == 0 {
            return true
        }
        return errno == EPERM
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
