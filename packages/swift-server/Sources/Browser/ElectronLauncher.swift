import AppKit
import Foundation
import Logging

private let electronOverlaySyncIntervalNanoseconds: UInt64 = 1_500_000_000

struct ElectronProcess {
    let process: Process
    let cdpPort: Int
    let displayName: String
}

struct ElectronAppAlreadyRunningError: LocalizedError {
    let message: String

    var errorDescription: String? { message }
}

enum ElectronLaunchError: LocalizedError {
    case appAlreadyRunning(String)
    case cdpNotAvailable(String)
    case remotDebuggingDisabled(String)

    var errorDescription: String? {
        switch self {
        case .appAlreadyRunning(let message),
             .cdpNotAvailable(let message),
             .remotDebuggingDisabled(let message):
            return message
        }
    }
}

struct ElectronInspectableTarget: Codable, Sendable, Equatable {
    let type: String
    let title: String?
    let url: String
    let webSocketDebuggerURL: String?

    enum CodingKeys: String, CodingKey {
        case type
        case title
        case url
        case webSocketDebuggerURL = "webSocketDebuggerUrl"
    }
}

struct ElectronResolvedApp: Equatable {
    let inputURL: URL
    let bundleURL: URL?
    let executableURL: URL
    let displayName: String

    var isAppBundle: Bool { bundleURL != nil }
}

final class ElectronLauncher {
    private let workspace: NSWorkspace
    private let fileManager: FileManager
    private let session: URLSession
    private let logger: Logger
    private let environment: [String: String]

    init(
        workspace: NSWorkspace = .shared,
        fileManager: FileManager = .default,
        session: URLSession = .shared,
        logger: Logger = Logger(label: "slicc.browser.electron-launcher"),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.workspace = workspace
        self.fileManager = fileManager
        self.session = session
        self.logger = logger
        self.environment = environment
    }

    func resolveAppPath(_ appPath: String) throws -> String {
        try resolveApp(appPath).executableURL.path
    }

    func findRunningInstances(appPath: String) throws -> [NSRunningApplication] {
        let resolved = try resolveApp(appPath)
        return workspace.runningApplications.filter { application in
            if let bundleURL = resolved.bundleURL,
               application.bundleURL?.standardizedFileURL == bundleURL.standardizedFileURL {
                return true
            }
            if let executableURL = application.executableURL?.standardizedFileURL,
               executableURL == resolved.executableURL.standardizedFileURL {
                return true
            }
            return false
        }
    }

    func terminateRunningApp(appPath: String) async throws {
        let apps = try findRunningInstances(appPath: appPath)
        guard !apps.isEmpty else { return }

        for app in apps where !app.isTerminated {
            logger.info("Terminating running Electron app", metadata: ["pid": .stringConvertible(app.processIdentifier)])
            _ = app.terminate()
        }
        if await waitForApplicationsToTerminate(apps, timeoutNanoseconds: 5_000_000_000) {
            return
        }

        for app in apps where !app.isTerminated {
            logger.warning("Force-terminating Electron app", metadata: ["pid": .stringConvertible(app.processIdentifier)])
            _ = app.forceTerminate()
        }
        _ = await waitForApplicationsToTerminate(apps, timeoutNanoseconds: 3_000_000_000)
    }

    func launch(appPath: String, cdpPort: Int, kill: Bool) async throws -> ElectronProcess {
        let resolved = try resolveApp(appPath)
        let runningApps = try findRunningInstances(appPath: appPath)

        if !runningApps.isEmpty && !kill {
            let message = "\(resolved.displayName) is already running. Re-run with --kill to relaunch it with remote debugging enabled."
            throw ElectronAppAlreadyRunningError(message: message)
        }
        if !runningApps.isEmpty {
            try await terminateRunningApp(appPath: appPath)
        }

        let process = Process()
        process.environment = environment
        process.standardOutput = Pipe()
        process.standardError = Pipe()

        if let bundleURL = resolved.bundleURL {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = [
                "-n", "-a", bundleURL.path,
                "-W", "--args",
                "--remote-debugging-port=\(cdpPort)"
            ]
        } else {
            process.executableURL = resolved.executableURL
            process.arguments = ["--remote-debugging-port=\(cdpPort)"]
        }

        logger.info("Launching Electron app", metadata: [
            "app": .string(resolved.displayName),
            "cdpPort": .stringConvertible(cdpPort)
        ])
        try process.run()

        enum LaunchOutcome {
            case cdpReady
            case processExited(Int32)
        }

        let outcome = try await withThrowingTaskGroup(of: LaunchOutcome.self) { group in
            group.addTask { [session, logger] in
                try await waitForCDPAvailability(cdpPort: cdpPort, session: session, logger: logger)
                return .cdpReady
            }
            group.addTask {
                .processExited(await Self.waitForProcessExit(process))
            }

            let first = try await group.next() ?? .cdpReady
            group.cancelAll()
            return first
        }

        switch outcome {
        case .cdpReady:
            logger.info("Electron CDP became available", metadata: ["cdpPort": .stringConvertible(cdpPort)])
            return ElectronProcess(process: process, cdpPort: cdpPort, displayName: resolved.displayName)
        case .processExited(let code):
            let message = "\(resolved.displayName) exited with code \(code) before remote debugging was available. This usually means the app has disabled remote debugging (EnableNodeCliInspectArguments fuse)."
            throw ElectronLaunchError.remotDebuggingDisabled(message)
        }
    }

    func resolveApp(_ appPath: String) throws -> ElectronResolvedApp {
        let normalizedPath = NSString(string: appPath).expandingTildeInPath
        let inputURL = URL(fileURLWithPath: normalizedPath).standardizedFileURL.resolvingSymlinksInPath()

        if inputURL.pathExtension.lowercased() == "app" {
            let bundleURL = inputURL
            let executableURL = try resolveExecutableURL(in: bundleURL)
            return ElectronResolvedApp(
                inputURL: inputURL,
                bundleURL: bundleURL,
                executableURL: executableURL,
                displayName: bundleURL.deletingPathExtension().lastPathComponent
            )
        }

        let bundleURL = bundleURL(containingExecutableAt: inputURL)
        return ElectronResolvedApp(
            inputURL: inputURL,
            bundleURL: bundleURL,
            executableURL: inputURL,
            displayName: bundleURL?.deletingPathExtension().lastPathComponent ?? inputURL.lastPathComponent
        )
    }

    func resolveExecutableURL(in bundleURL: URL) throws -> URL {
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        let displayName = bundleURL.deletingPathExtension().lastPathComponent
        let expectedURL = macOSDirectory.appendingPathComponent(displayName)
        if isExecutableFile(at: expectedURL) {
            return expectedURL.standardizedFileURL
        }

        let preferredNames = ["Electron"]
        for name in preferredNames {
            let candidate = macOSDirectory.appendingPathComponent(name)
            if isExecutableFile(at: candidate) {
                return candidate.standardizedFileURL
            }
        }

        let helpers = ["helper", "crash", "gpu", "renderer", "plugin", "utility"]
        let entries = try fileManager.contentsOfDirectory(
            at: macOSDirectory,
            includingPropertiesForKeys: [.isRegularFileKey, .isExecutableKey],
            options: [.skipsHiddenFiles]
        )

        for entry in entries {
            let lowercased = entry.lastPathComponent.lowercased()
            guard !lowercased.hasSuffix(".sh") else { continue }
            guard helpers.allSatisfy({ !lowercased.contains($0) }) else { continue }
            if isExecutableFile(at: entry) {
                return entry.standardizedFileURL
            }
        }

        throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: expectedURL.path])
    }

    private func isExecutableFile(at url: URL) -> Bool {
        guard fileManager.fileExists(atPath: url.path) else { return false }
        return fileManager.isExecutableFile(atPath: url.path)
    }

    private func bundleURL(containingExecutableAt executableURL: URL) -> URL? {
        let components = executableURL.pathComponents
        guard let appIndex = components.lastIndex(where: { $0.lowercased().hasSuffix(".app") }) else {
            return nil
        }

        let bundlePath = NSString.path(withComponents: Array(components.prefix(appIndex + 1)))
        return URL(fileURLWithPath: bundlePath).standardizedFileURL
    }

    private func waitForApplicationsToTerminate(
        _ applications: [NSRunningApplication],
        timeoutNanoseconds: UInt64
    ) async -> Bool {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
        while DispatchTime.now().uptimeNanoseconds < deadline {
            if applications.allSatisfy(\.isTerminated) {
                return true
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return applications.allSatisfy(\.isTerminated)
    }

    private static func waitForProcessExit(_ process: Process) async -> Int32 {
        while process.isRunning {
            do {
                try await Task.sleep(nanoseconds: 100_000_000)
            } catch {
                // Cancellation — stop polling. Can't read terminationStatus
                // while the process is still running (NSTask throws).
                return -1
            }
        }
        return process.terminationStatus
    }
}

private func waitForCDPAvailability(
    cdpPort: Int,
    session: URLSession,
    logger: Logger,
    retries: Int = 40,
    delayNanoseconds: UInt64 = 500_000_000
) async throws {
    let url = URL(string: "http://127.0.0.1:\(cdpPort)/json/version")!

    for attempt in 0..<retries {
        try Task.checkCancellation()
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.5

        if let (data, response) = try? await session.data(for: request),
           let http = response as? HTTPURLResponse,
           http.statusCode == 200,
           !data.isEmpty {
            logger.debug("Electron CDP probe succeeded", metadata: ["attempt": .stringConvertible(attempt + 1)])
            return
        }

        try await Task.sleep(nanoseconds: delayNanoseconds)
    }

    throw ElectronLaunchError.cdpNotAvailable("Could not connect to Electron CDP on port \(cdpPort).")
}

func buildElectronOverlayAppURL(servePort: Int) -> String {
    "http://localhost:\(servePort)/electron"
}

func buildElectronOverlayBootstrapScript(bundleSource: String, appURL: String) -> String {
    let escapedAppURL = appURL.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    let injectionCall = "if(document.body){window.__SLICC_ELECTRON_OVERLAY__?.inject({appUrl:\"\(escapedAppURL)\"});}else{document.addEventListener('DOMContentLoaded',function(){window.__SLICC_ELECTRON_OVERLAY__?.inject({appUrl:\"\(escapedAppURL)\"});});}"
    return bundleSource + "\n" + injectionCall
}

func shouldInjectElectronOverlayTarget(_ target: ElectronInspectableTarget) -> Bool {
    guard target.type == "page", let debuggerURL = target.webSocketDebuggerURL, !debuggerURL.isEmpty else {
        return false
    }
    let url = target.url.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !url.isEmpty else { return false }
    return !url.hasPrefix("devtools://")
        && !url.hasPrefix("chrome://")
        && !url.hasPrefix("chrome-extension://")
}

func selectBestOverlayTargets(_ targets: [ElectronInspectableTarget]) -> [ElectronInspectableTarget] {
    let injectable = targets.filter(shouldInjectElectronOverlayTarget)
    var grouped: [String: [ElectronInspectableTarget]] = [:]
    var orderedOrigins: [String] = []

    for target in injectable {
        let origin = safeOverlayOrigin(for: target)
        if grouped[origin] == nil {
            orderedOrigins.append(origin)
            grouped[origin] = []
        }
        grouped[origin]?.append(target)
    }

    return orderedOrigins.compactMap { origin in
        grouped[origin]?.max(by: { scoreOverlayTarget($0) < scoreOverlayTarget($1) })
    }
}

private func safeOverlayOrigin(for target: ElectronInspectableTarget) -> String {
    guard let url = URL(string: target.url), let scheme = url.scheme, let host = url.host else {
        return target.url
    }
    if let port = url.port {
        return "\(scheme)://\(host):\(port)"
    }
    return "\(scheme)://\(host)"
}

private func scoreOverlayTarget(_ target: ElectronInspectableTarget) -> Int {
    var score = min(target.title?.count ?? 0, 120)
    if target.url.contains("isMinimized=") || target.url.contains("deepLink=") {
        score -= 200
    }
    if let hashIndex = target.url.firstIndex(of: "#") {
        score -= min(target.url.distance(from: hashIndex, to: target.url.endIndex), 100)
    }
    return score
}

/// Pure decisions for the overlay injector's per-target state machine.
/// Extracted so unit tests can cover the reload/escalation logic without
/// spinning up real CDP sockets.
enum OverlayInjectionAction: Equatable {
    /// CSP was bypassed on a prior connection — inject the overlay and stop.
    case injectOnly
    /// First connection for this target URL — inject, then probe whether the
    /// overlay iframe actually loaded.
    case injectThenProbe
}

enum OverlayPostProbeAction: Equatable {
    /// Probe reported the overlay iframe is loaded; nothing more to do.
    case done
    /// Probe reported the iframe was blocked (e.g. by CSP). Reload the page
    /// so `Page.setBypassCSP` takes effect on the fresh navigation.
    case reloadWithBypass
}

enum OverlayPostReloadAction: Equatable {
    /// Bypassed-reload was not requested — nothing more to do beyond
    /// re-injecting the overlay script.
    case noEscalationRequested
    /// Probe reported the overlay iframe is loaded after the bypassed reload.
    case done
    /// Iframe still blocked after the bypassed reload — escalate to the
    /// Fetch-proxy fallback so we can strip CSP headers ourselves.
    case escalateToFetchProxy
}

final class ElectronOverlayInjector: @unchecked Sendable {
    private let cdpPort: Int
    private let servePort: Int
    private let projectRoot: URL
    private let session: URLSession
    private let logger: Logger
    private let probeDelayNanoseconds: UInt64
    private let stateQueue = DispatchQueue(label: "slicc.browser.electron-overlay-injector")
    private var sessions: [String: OverlayTargetSession] = [:]
    private var cspBypassedURLs = Set<String>()
    private var pollTask: Task<Void, Never>?

    init(
        cdpPort: Int,
        servePort: Int,
        projectRoot: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        session: URLSession = .shared,
        logger: Logger = Logger(label: "slicc.browser.electron-overlay"),
        probeDelayNanoseconds: UInt64 = 1_500_000_000
    ) {
        self.cdpPort = cdpPort
        self.servePort = servePort
        self.projectRoot = projectRoot
        self.session = session
        self.logger = logger
        self.probeDelayNanoseconds = probeDelayNanoseconds
    }

    func start() {
        let alreadyRunning = stateQueue.sync { pollTask != nil }
        guard !alreadyRunning else { return }
        logger.info("Starting overlay injector polling loop", metadata: [
            "cdpPort": .stringConvertible(cdpPort),
            "servePort": .stringConvertible(servePort),
            "projectRoot": .string(projectRoot.path)
        ])
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runPollingLoop()
        }
        stateQueue.sync { pollTask = task }
    }

    func stop() {
        let toClose: [OverlayTargetSession] = stateQueue.sync {
            pollTask?.cancel()
            pollTask = nil
            let snapshot = Array(sessions.values)
            sessions.removeAll()
            return snapshot
        }
        for session in toClose {
            session.stop()
        }
    }

    /// First-time connect dispatch. Encapsulates the bypassed-state guard so
    /// subsequent reconnections to a URL that has already triggered a CSP
    /// bypass skip the probe/reload path entirely.
    static func openAction(alreadyCSPBypassed: Bool) -> OverlayInjectionAction {
        alreadyCSPBypassed ? .injectOnly : .injectThenProbe
    }

    /// Decide whether to reload with CSP bypass after probing the freshly
    /// injected overlay iframe.
    static func postProbeAction(loaded: Bool) -> OverlayPostProbeAction {
        loaded ? .done : .reloadWithBypass
    }

    /// Decide whether to escalate to the Fetch proxy after the bypassed
    /// reload. Mirrors node-server: escalation only fires when the original
    /// `injectThenProbe` path requested it (i.e. the very first reload).
    static func postReloadAction(loaded: Bool, escalationRequested: Bool) -> OverlayPostReloadAction {
        guard escalationRequested else { return .noEscalationRequested }
        return loaded ? .done : .escalateToFetchProxy
    }

    private func runPollingLoop() async {
        logger.info("Overlay polling loop started")
        while !Task.isCancelled {
            do {
                try await syncTargets()
            } catch {
                logger.error("Electron overlay sync failed", metadata: ["error": .string(error.localizedDescription)])
            }
            try? await Task.sleep(nanoseconds: electronOverlaySyncIntervalNanoseconds)
        }
    }

    private func syncTargets() async throws {
        let bootstrapScript = try loadBootstrapScript()
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(cdpPort)/json/list")!)
        request.timeoutInterval = 2
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw ElectronLaunchError.cdpNotAvailable("Failed to list Electron CDP targets on port \(cdpPort).")
        }

        let targets = try JSONDecoder().decode([ElectronInspectableTarget].self, from: data)
        let selectedTargets = selectBestOverlayTargets(targets)
        logger.debug("syncTargets", metadata: [
            "totalTargets": .stringConvertible(targets.count),
            "selectedTargets": .stringConvertible(selectedTargets.count)
        ])
        let liveTargetIDs = Set(selectedTargets.compactMap(\.webSocketDebuggerURL))

        // Drop sessions whose CDP target disappeared (e.g. tab/window closed).
        let stale: [OverlayTargetSession] = stateQueue.sync {
            var dropped: [OverlayTargetSession] = []
            for (targetID, session) in sessions where !liveTargetIDs.contains(targetID) {
                dropped.append(session)
                sessions.removeValue(forKey: targetID)
            }
            return dropped
        }
        for session in stale {
            session.stop()
        }

        for target in selectedTargets {
            guard let targetID = target.webSocketDebuggerURL else { continue }
            let alreadyConnected = stateQueue.sync { sessions[targetID] != nil }
            guard !alreadyConnected else { continue }

            let session = makeTargetSession(target: target, bootstrapScript: bootstrapScript)
            stateQueue.sync { sessions[targetID] = session }
            session.start()
        }
    }

    private func makeTargetSession(target: ElectronInspectableTarget, bootstrapScript: String) -> OverlayTargetSession {
        let isAlreadyBypassed: @Sendable (String) -> Bool = { [weak self] url in
            guard let self else { return false }
            return self.stateQueue.sync { self.cspBypassedURLs.contains(url) }
        }
        let recordBypassed: @Sendable (String) -> Void = { [weak self] url in
            guard let self else { return }
            self.stateQueue.sync { _ = self.cspBypassedURLs.insert(url) }
        }
        let onClose: @Sendable (String) -> Void = { [weak self] targetID in
            guard let self else { return }
            self.stateQueue.sync { _ = self.sessions.removeValue(forKey: targetID) }
        }
        return OverlayTargetSession(
            target: target,
            bootstrapScript: bootstrapScript,
            servePort: servePort,
            session: session,
            logger: logger,
            probeDelayNanoseconds: probeDelayNanoseconds,
            isAlreadyBypassed: isAlreadyBypassed,
            recordBypassed: recordBypassed,
            onClose: onClose
        )
    }

    /// Snapshot of URLs whose CSP has been bypassed in this injector's
    /// lifetime. Exposed for tests; not used at runtime.
    func _testing_bypassedURLs() -> Set<String> {
        stateQueue.sync { cspBypassedURLs }
    }

    /// Seed bypassed-URL state for tests so we can exercise the
    /// `alreadyBypassed` branch without driving a real CDP session.
    func _testing_seedBypassedURL(_ url: String) {
        stateQueue.sync { _ = cspBypassedURLs.insert(url) }
    }

    private func loadBootstrapScript() throws -> String {
        let fileManager = FileManager.default
        let candidates = [
            projectRoot,
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
            projectRoot.deletingLastPathComponent()
        ]
        let relativePaths = ["dist/ui/electron-overlay.js", "dist/ui/electron-overlay-entry.js"]

        for root in candidates {
            for relativePath in relativePaths {
                let candidate = root.appendingPathComponent(relativePath)
                if fileManager.fileExists(atPath: candidate.path) {
                    let source = try String(contentsOf: candidate, encoding: .utf8)
                    return buildElectronOverlayBootstrapScript(
                        bundleSource: source,
                        appURL: buildElectronOverlayAppURL(servePort: servePort)
                    )
                }
            }
        }

        logger.warning("Electron overlay bundle not found; using inline fallback")
        return buildElectronOverlayBootstrapScript(
            bundleSource: inlineFallbackOverlayBundle(),
            appURL: buildElectronOverlayAppURL(servePort: servePort)
        )
    }

    private func inlineFallbackOverlayBundle() -> String {
        """
        window.__SLICC_ELECTRON_OVERLAY__ = window.__SLICC_ELECTRON_OVERLAY__ || {
          inject: function(options) {
            var id = 'slicc-electron-overlay-root';
            if (document.getElementById(id)) return;
            var iframe = document.createElement('iframe');
            iframe.id = id;
            iframe.src = options && options.appUrl ? options.appUrl : '';
            iframe.style.position = 'fixed';
            iframe.style.top = '16px';
            iframe.style.right = '16px';
            iframe.style.width = '420px';
            iframe.style.height = '80vh';
            iframe.style.zIndex = '2147483647';
            iframe.style.border = '1px solid rgba(0,0,0,0.15)';
            iframe.style.borderRadius = '12px';
            iframe.style.boxShadow = '0 16px 48px rgba(0,0,0,0.25)';
            iframe.style.background = '#fff';
            (document.body || document.documentElement).appendChild(iframe);
          },
          remove: function() {
            var existing = document.getElementById('slicc-electron-overlay-root');
            if (existing) existing.remove();
          }
        };
        """
    }

}

// MARK: - OverlayTargetSession

/// Persistent CDP session for one Electron renderer target. Owns the
/// `Page.enable` / `Runtime.enable` / `Page.setBypassCSP` dance, the post-
/// inject iframe probe, and the reload-with-bypass + Fetch-proxy escalation
/// fallback. Mirrors `ElectronOverlayInjector` in
/// `packages/node-server/src/electron-controller.ts` so swift-server reaches
/// parity inside CSP-bearing Electron apps (e.g. AEM Desktop).
final class OverlayTargetSession: @unchecked Sendable {
    private let target: ElectronInspectableTarget
    private let bootstrapScript: String
    private let servePort: Int
    private let urlSession: URLSession
    private let logger: Logger
    private let probeDelayNanoseconds: UInt64
    private let isAlreadyBypassed: @Sendable (String) -> Bool
    private let recordBypassed: @Sendable (String) -> Void
    private let onClose: @Sendable (String) -> Void

    private let stateQueue = DispatchQueue(label: "slicc.browser.electron-overlay-session")
    private var socket: URLSessionWebSocketTask?
    private var recvTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var messageIdCounter = 0
    private var pendingReload = false
    private var pendingCspEscalation = false
    private var fetchProxyActive = false
    private var addedScriptIdentifier: String?
    private var responseWaiters: [Int: CheckedContinuation<[String: Any]?, Never>] = [:]
    private var closed = false

    init(
        target: ElectronInspectableTarget,
        bootstrapScript: String,
        servePort: Int,
        session: URLSession,
        logger: Logger,
        probeDelayNanoseconds: UInt64,
        isAlreadyBypassed: @escaping @Sendable (String) -> Bool,
        recordBypassed: @escaping @Sendable (String) -> Void,
        onClose: @escaping @Sendable (String) -> Void
    ) {
        self.target = target
        self.bootstrapScript = bootstrapScript
        self.servePort = servePort
        self.urlSession = session
        self.logger = logger
        self.probeDelayNanoseconds = probeDelayNanoseconds
        self.isAlreadyBypassed = isAlreadyBypassed
        self.recordBypassed = recordBypassed
        self.onClose = onClose
    }

    func start() {
        guard let urlString = target.webSocketDebuggerURL,
              let url = URL(string: urlString) else { return }
        let task = urlSession.webSocketTask(with: url)
        stateQueue.sync { socket = task }
        task.resume()

        let recv = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.runReceiveLoop()
        }
        let connect = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.runConnectFlow()
        }
        stateQueue.sync {
            recvTask = recv
            connectTask = connect
        }
    }

    private struct StopSnapshot {
        let wasAlreadyClosed: Bool
        let socket: URLSessionWebSocketTask?
        let recvTask: Task<Void, Never>?
        let connectTask: Task<Void, Never>?
        let waiters: [Int: CheckedContinuation<[String: Any]?, Never>]
    }

    func stop() {
        let snapshot: StopSnapshot = stateQueue.sync {
            let was = closed
            closed = true
            let captured = StopSnapshot(
                wasAlreadyClosed: was,
                socket: socket,
                recvTask: recvTask,
                connectTask: connectTask,
                waiters: responseWaiters
            )
            socket = nil
            recvTask = nil
            connectTask = nil
            responseWaiters.removeAll()
            return captured
        }
        if snapshot.wasAlreadyClosed { return }
        for (_, waiter) in snapshot.waiters {
            waiter.resume(returning: nil)
        }
        snapshot.socket?.cancel(with: .goingAway, reason: nil)
        snapshot.recvTask?.cancel()
        snapshot.connectTask?.cancel()
    }

    // MARK: Connection flow

    private func runConnectFlow() async {
        let alreadyBypassed = isAlreadyBypassed(target.url)
        logger.info("Overlay target connection opening", metadata: [
            "target": .string(target.url),
            "alreadyBypassed": .stringConvertible(alreadyBypassed)
        ])

        _ = await sendCommand(method: "Runtime.enable", awaitResponse: true)
        _ = await sendCommand(method: "Page.enable", awaitResponse: true)
        _ = await sendCommand(method: "Page.setBypassCSP", params: ["enabled": true], awaitResponse: true)
        // Install the bootstrap as a permanent new-document hook so it
        // re-runs automatically after the reload below (and after any
        // additional navigation the host app's own bootstrap may trigger
        // — observed in AEM Desktop where Runtime.evaluate after
        // Page.loadEventFired raced a fresh document and did not stick).
        await registerNewDocumentScript()

        let action = ElectronOverlayInjector.openAction(alreadyCSPBypassed: alreadyBypassed)
        switch action {
        case .injectOnly:
            logger.info("Injecting overlay (CSP already bypassed)", metadata: ["target": .string(target.url)])
            await sendBootstrap()
            _ = await verifyOverlayPresent(context: "inject-only")
        case .injectThenProbe:
            logger.info("Injecting overlay (first attempt)", metadata: ["target": .string(target.url)])
            await sendBootstrap()
            _ = await verifyOverlayPresent(context: "first-inject")
            try? await Task.sleep(nanoseconds: probeDelayNanoseconds)
            if Task.isCancelled || isClosed() { return }
            let loaded = await probeOverlayLoaded()
            await handlePostProbe(loaded: loaded)
        }
    }

    private func handlePostProbe(loaded: Bool) async {
        let decision = ElectronOverlayInjector.postProbeAction(loaded: loaded)
        switch decision {
        case .done:
            logger.info("Overlay iframe loaded successfully — no CSP reload needed", metadata: ["target": .string(target.url)])
            recordBypassed(target.url)
        case .reloadWithBypass:
            logger.info("Overlay iframe blocked by CSP, reloading with bypass", metadata: ["target": .string(target.url)])
            recordBypassed(target.url)
            stateQueue.sync {
                pendingReload = true
                pendingCspEscalation = true
            }
            _ = await sendCommand(method: "Page.reload", params: ["ignoreCache": true])
        }
    }

    // MARK: Event handling

    private func runReceiveLoop() async {
        while !Task.isCancelled {
            guard let activeSocket = stateQueue.sync(execute: { socket }) else { return }
            do {
                let message = try await activeSocket.receive()
                guard case .string(let text) = message,
                      let data = text.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    continue
                }
                if let id = json["id"] as? Int {
                    let waiter: CheckedContinuation<[String: Any]?, Never>? = stateQueue.sync {
                        responseWaiters.removeValue(forKey: id)
                    }
                    waiter?.resume(returning: json["result"] as? [String: Any])
                } else if let method = json["method"] as? String {
                    await handleEvent(method: method, params: json["params"] as? [String: Any])
                }
            } catch {
                if !isClosed() {
                    logger.debug("Overlay session receive loop ended", metadata: [
                        "target": .string(target.url),
                        "error": .string(error.localizedDescription)
                    ])
                }
                let targetID = target.webSocketDebuggerURL ?? target.url
                onClose(targetID)
                return
            }
        }
    }

    private func handleEvent(method: String, params: [String: Any]?) async {
        switch method {
        case "Page.loadEventFired":
            await handleLoadEventFired()
        case "Fetch.requestPaused":
            await handleFetchRequestPaused(params: params ?? [:])
        default:
            break
        }
    }

    private func handleLoadEventFired() async {
        let snapshot: (reload: Bool, escalation: Bool) = stateQueue.sync {
            let r = pendingReload
            let e = pendingCspEscalation
            pendingReload = false
            pendingCspEscalation = false
            return (r, e)
        }
        guard snapshot.reload else { return }

        logger.info("Page loaded after CSP-bypass reload, re-injecting overlay", metadata: ["target": .string(target.url)])
        // The CDP session keeps `Page.setBypassCSP` enabled across reloads,
        // but re-arm it defensively to match node-server.
        _ = await sendCommand(method: "Page.setBypassCSP", params: ["enabled": true], awaitResponse: true)
        await sendBootstrap()
        // Read back the global so a "didn't stick" reinject shows up in logs
        // immediately instead of silently failing the second-probe later.
        _ = await verifyOverlayPresent(context: "post-reload-inject")

        let escalationRequested = snapshot.escalation
        guard escalationRequested else { return }

        try? await Task.sleep(nanoseconds: probeDelayNanoseconds)
        if Task.isCancelled || isClosed() { return }
        let loaded = await probeOverlayLoaded()
        let decision = ElectronOverlayInjector.postReloadAction(loaded: loaded, escalationRequested: true)
        switch decision {
        case .done, .noEscalationRequested:
            logger.info("Overlay iframe loaded successfully after CSP reload — no proxy needed", metadata: ["target": .string(target.url)])
        case .escalateToFetchProxy:
            await activateFetchProxy()
        }
    }

    private func activateFetchProxy() async {
        // For file:// (or other no-http-origin) targets, fall back to the
        // overlay iframe's own http origin — Fetch.enable patterns must be
        // http(s) and the iframe is what we ultimately need unblocked.
        let origin = OverlayTargetSession.fetchProxyOrigin(targetURL: target.url, servePort: servePort)
        logger.warning("CSP reload insufficient, escalating to Fetch proxy", metadata: [
            "target": .string(target.url),
            "origin": .string(origin)
        ])
        stateQueue.sync {
            fetchProxyActive = true
            pendingReload = true
        }
        _ = await sendCommand(method: "Fetch.enable", params: [
            "patterns": [["urlPattern": "\(origin)/*", "requestStage": "Request"]]
        ], awaitResponse: true)
        _ = await sendCommand(method: "Page.reload", params: ["ignoreCache": true])
    }

    // MARK: Fetch-proxy escalation

    private func handleFetchRequestPaused(params: [String: Any]) async {
        let isActive = stateQueue.sync { fetchProxyActive }
        guard isActive else { return }
        guard let requestId = params["requestId"] as? String else {
            logger.warning("Fetch.requestPaused without requestId, skipping")
            return
        }
        let request = params["request"] as? [String: Any] ?? [:]
        let urlString = request["url"] as? String ?? ""
        let method = request["method"] as? String ?? "GET"
        let headers = request["headers"] as? [String: String] ?? [:]
        let postData = request["postData"] as? String
        let accept = headers["Accept"] ?? headers["accept"] ?? ""

        // Only proxy HTML document requests; everything else goes through unchanged.
        guard accept.contains("text/html") else {
            _ = await sendCommand(method: "Fetch.continueRequest", params: ["requestId": requestId])
            return
        }

        logger.info("Proxying request to strip CSP", metadata: ["url": .string(String(urlString.prefix(80)))])
        do {
            let proxied = try await fetchAndStripCSP(urlString: urlString, method: method, headers: headers, postData: postData)
            _ = await sendCommand(method: "Fetch.fulfillRequest", params: [
                "requestId": requestId,
                "responseCode": proxied.statusCode,
                "responseHeaders": proxied.headers,
                "body": proxied.bodyBase64
            ], awaitResponse: true)
            if proxied.strippedCSP {
                logger.info("Stripped CSP", metadata: ["url": .string(String(urlString.prefix(80)))])
            }
        } catch {
            logger.error("Fetch-proxy request failed", metadata: [
                "url": .string(String(urlString.prefix(80))),
                "error": .string(error.localizedDescription)
            ])
            _ = await sendCommand(method: "Fetch.failRequest", params: [
                "requestId": requestId,
                "errorReason": "Failed"
            ])
        }
    }

    private struct ProxiedResponse {
        let statusCode: Int
        let headers: [[String: String]]
        let bodyBase64: String
        let strippedCSP: Bool
    }

    private func fetchAndStripCSP(
        urlString: String,
        method: String,
        headers: [String: String],
        postData: String?
    ) async throws -> ProxiedResponse {
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        // Skip headers URLSession owns / hop-by-hop on the request side.
        let stripRequestHeaders: Set<String> = ["content-length", "host", "connection", "keep-alive", "transfer-encoding"]
        for (name, value) in headers where !stripRequestHeaders.contains(name.lowercased()) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let postData {
            request.httpBody = Data(base64Encoded: postData) ?? postData.data(using: .utf8)
        }

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        let hopByHop: Set<String> = [
            "content-security-policy",
            "content-security-policy-report-only",
            "transfer-encoding",
            "connection",
            "keep-alive"
        ]
        var responseHeaders: [[String: String]] = []
        var strippedCSP = false
        let rawHeaders = http.allHeaderFields as? [String: String] ?? [:]
        for (name, value) in rawHeaders {
            let lower = name.lowercased()
            if lower.contains("content-security-policy") {
                strippedCSP = true
                continue
            }
            if hopByHop.contains(lower) { continue }
            if lower == "content-length" {
                responseHeaders.append(["name": name, "value": String(data.count)])
                continue
            }
            responseHeaders.append(["name": name, "value": value])
        }
        return ProxiedResponse(
            statusCode: http.statusCode,
            headers: responseHeaders,
            bodyBase64: data.base64EncodedString(),
            strippedCSP: strippedCSP
        )
    }

    // MARK: Helpers

    private func sendBootstrap() async {
        _ = await sendCommand(method: "Runtime.evaluate", params: [
            "expression": bootstrapScript,
            "awaitPromise": false
        ])
    }

    /// Install the bootstrap as a `Page.addScriptToEvaluateOnNewDocument`
    /// hook so it re-runs automatically on every new document — including
    /// ones the host app's own bootstrap may create after our reload (the
    /// AEM Desktop case where the re-evaluate after `Page.loadEventFired`
    /// would otherwise race a fresh document and not stick).
    private func registerNewDocumentScript() async {
        let result = await sendCommand(method: "Page.addScriptToEvaluateOnNewDocument", params: [
            "source": bootstrapScript
        ], awaitResponse: true)
        if let identifier = result?["identifier"] as? String {
            stateQueue.sync { addedScriptIdentifier = identifier }
            logger.debug("Registered new-document overlay bootstrap", metadata: [
                "target": .string(target.url),
                "identifier": .string(identifier)
            ])
        } else {
            logger.warning("Page.addScriptToEvaluateOnNewDocument returned no identifier", metadata: [
                "target": .string(target.url)
            ])
        }
    }

    /// Read back `window.__SLICC_ELECTRON_OVERLAY__` (and the overlay host)
    /// right after injection so a silently-lost inject (e.g. a stale
    /// execution context the bootstrap script ran in) shows up in the logs
    /// instead of only being detected later by the iframe probe.
    @discardableResult
    private func verifyOverlayPresent(context: String) async -> Bool {
        let expression = """
        (function() {
          try {
            var hasGlobal = typeof window.__SLICC_ELECTRON_OVERLAY__ !== 'undefined';
            var hasRoot = !!document.getElementById('slicc-electron-overlay-root');
            return (hasGlobal ? 'g' : '-') + (hasRoot ? 'r' : '-');
          } catch (e) { return 'err:' + String(e); }
        })()
        """
        let result = await sendCommand(method: "Runtime.evaluate", params: [
            "expression": expression,
            "awaitPromise": false,
            "returnByValue": true
        ], awaitResponse: true)
        let value = (result?["result"] as? [String: Any])?["value"] as? String ?? ""
        let stuck = value.hasPrefix("g")
        if stuck {
            logger.info("Overlay inject verified present", metadata: [
                "target": .string(target.url),
                "context": .string(context),
                "marker": .string(value)
            ])
        } else {
            logger.warning("Overlay inject did NOT take effect — likely stale execution context", metadata: [
                "target": .string(target.url),
                "context": .string(context),
                "marker": .string(value)
            ])
        }
        return stuck
    }

    private func probeOverlayLoaded() async -> Bool {
        // Mirrors node-server's `probeOverlayIframeLoaded`: walks host →
        // shadowRoot → sidebar → iframe and only reports success when the
        // iframe actually has a `src`.
        let expression = """
        (function() {
          var host = document.getElementById('slicc-electron-overlay-root');
          if (!host || !host.shadowRoot) return 'no-host';
          var sidebar = host.shadowRoot.querySelector('slicc-electron-sidebar');
          if (!sidebar || !sidebar.shadowRoot) return 'no-sidebar';
          var iframe = sidebar.shadowRoot.querySelector('iframe');
          if (!iframe) return 'no-iframe';
          if (!iframe.src) return 'no-src';
          return 'ok';
        })()
        """
        let result = await sendCommand(method: "Runtime.evaluate", params: [
            "expression": expression,
            "awaitPromise": false,
            "returnByValue": true
        ], awaitResponse: true)
        if let inner = result?["result"] as? [String: Any],
           let value = inner["value"] as? String {
            return value == "ok"
        }
        return false
    }

    @discardableResult
    private func sendCommand(method: String, params: [String: Any]? = nil, awaitResponse: Bool = false) async -> [String: Any]? {
        let id: Int = stateQueue.sync {
            messageIdCounter += 1
            return messageIdCounter
        }
        var msg: [String: Any] = ["id": id, "method": method]
        if let params { msg["params"] = params }

        if awaitResponse {
            return await withCheckedContinuation { (cont: CheckedContinuation<[String: Any]?, Never>) in
                let activeSocket: URLSessionWebSocketTask? = stateQueue.sync {
                    if closed { return nil }
                    responseWaiters[id] = cont
                    return socket
                }
                guard let activeSocket else {
                    cont.resume(returning: nil)
                    return
                }
                Task { [weak self] in
                    do {
                        let data = try JSONSerialization.data(withJSONObject: msg)
                        guard let text = String(data: data, encoding: .utf8) else {
                            throw CocoaError(.coderInvalidValue)
                        }
                        try await activeSocket.send(.string(text))
                    } catch {
                        guard let self else { return }
                        let waiter: CheckedContinuation<[String: Any]?, Never>? = self.stateQueue.sync {
                            self.responseWaiters.removeValue(forKey: id)
                        }
                        waiter?.resume(returning: nil)
                    }
                }
            }
        } else {
            guard let activeSocket = stateQueue.sync(execute: { socket }) else { return nil }
            do {
                let data = try JSONSerialization.data(withJSONObject: msg)
                if let text = String(data: data, encoding: .utf8) {
                    try await activeSocket.send(.string(text))
                }
            } catch {
                logger.debug("Failed to send CDP command", metadata: [
                    "method": .string(method),
                    "error": .string(error.localizedDescription)
                ])
            }
            return nil
        }
    }

    private func isClosed() -> Bool {
        stateQueue.sync { closed }
    }

    static func overlayOrigin(for urlString: String) -> String? {
        guard let url = URL(string: urlString), let scheme = url.scheme, let host = url.host else {
            return nil
        }
        if let port = url.port { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    /// Resolve the Fetch.enable origin pattern: prefer the parent page's
    /// http origin (matches node-server byte-for-byte), but for file:// (or
    /// other no-http-origin) targets fall back to the overlay iframe's own
    /// `http://localhost:<servePort>` origin so the iframe load is at least
    /// covered by Fetch interception.
    static func fetchProxyOrigin(targetURL: String, servePort: Int) -> String {
        if let origin = overlayOrigin(for: targetURL) {
            return origin
        }
        return "http://localhost:\(servePort)"
    }
}
