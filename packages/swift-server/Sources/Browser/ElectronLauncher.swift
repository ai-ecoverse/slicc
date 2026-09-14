import AppKit
import Foundation
import Logging

private let electronOverlaySyncIntervalNanoseconds: UInt64 = 1_500_000_000







let electronOverlayPresenceCheckIntervalNanoseconds: UInt64 = 2_000_000_000










let overlayFirstProbeBudgetNanoseconds: UInt64 = 3_000_000_000
let overlayFirstProbeIntervalNanoseconds: UInt64 = 200_000_000

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
    case overlayConfigUnresolved(String)

    var errorDescription: String? {
        switch self {
        case .appAlreadyRunning(let message),
            .cdpNotAvailable(let message),
            .remotDebuggingDisabled(let message),
            .overlayConfigUnresolved(let message):
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
                application.bundleURL?.standardizedFileURL == bundleURL.standardizedFileURL
            {
                return true
            }
            if let executableURL = application.executableURL?.standardizedFileURL,
                executableURL == resolved.executableURL.standardizedFileURL
            {
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
                "--remote-debugging-port=\(cdpPort)",
            ]
        } else {
            process.executableURL = resolved.executableURL
            process.arguments = ["--remote-debugging-port=\(cdpPort)"]
        }

        logger.info(
            "Launching Electron app",
            metadata: [
                "app": .string(resolved.displayName),
                "cdpPort": .stringConvertible(cdpPort),
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
            let message =
                "\(resolved.displayName) exited with code \(code) before remote debugging was available. This usually means the app has disabled remote debugging (EnableNodeCliInspectArguments fuse)."
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
            !data.isEmpty
        {
            logger.debug("Electron CDP probe succeeded", metadata: ["attempt": .stringConvertible(attempt + 1)])
            return
        }

        try await Task.sleep(nanoseconds: delayNanoseconds)
    }

    throw ElectronLaunchError.cdpNotAvailable("Could not connect to Electron CDP on port \(cdpPort).")
}







let bridgeRoleQueryParam = "role"
let bridgeRoleLeader = "leader"
let bridgeRoleFollower = "follower"






let trayQueryParam = "tray"






struct ThinBridgeConfig: Equatable, Sendable {
    let hostedLeaderOrigin: String
    let bridgeWsUrl: String
    let bridgeToken: String
}

enum OverlayRole: String, Sendable {
    case leader
    case follower
}

struct ThinOverlayURLOptions {
    let config: ThinBridgeConfig
    let role: OverlayRole
    let activeTab: String?
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    let trayJoinUrl: String?

    init(config: ThinBridgeConfig, role: OverlayRole, activeTab: String? = nil, trayJoinUrl: String? = nil) {
        self.config = config
        self.role = role
        self.activeTab = activeTab
        self.trayJoinUrl = trayJoinUrl
    }
}







func buildThinOverlayAppURL(options: ThinOverlayURLOptions) -> String {
    let base = options.config.hostedLeaderOrigin
    let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
    guard var components = URLComponents(string: "\(trimmed)/electron") else {
        return "\(trimmed)/electron"
    }
    var items: [URLQueryItem] = components.queryItems ?? []
    items.append(URLQueryItem(name: BridgeSecurity.wsQueryParam, value: options.config.bridgeWsUrl))
    items.append(URLQueryItem(name: BridgeSecurity.tokenQueryParam, value: options.config.bridgeToken))
    items.append(URLQueryItem(name: bridgeRoleQueryParam, value: options.role.rawValue))
    if let activeTab = options.activeTab, !activeTab.isEmpty, activeTab != "chat" {
        items.append(URLQueryItem(name: "tab", value: activeTab))
    }
    if let trayJoinUrl = options.trayJoinUrl {
        items.append(URLQueryItem(name: trayQueryParam, value: trayJoinUrl))
    }
    components.queryItems = items
    return components.string ?? "\(trimmed)/electron"
}







func resolveHostedLeaderOrigin(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
    let explicit = environment["SLICC_HOSTED_LEADER_ORIGIN"] ?? environment["WORKER_BASE_URL"]
    if let explicit, !explicit.isEmpty {
        return explicit.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
    }
    
    return "https://www.sliccy.ai"
}





struct ThinBootstrapSet: Sendable {
    let leader: String
    let follower: String
    
    
    let status: String
}

func buildElectronOverlayBootstrapScript(bundleSource: String, appURL: String) -> String {
    let escapedAppURL = appURL.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    
    
    
    
    
    
    
    let frameGuard = "try{if(window.top!==window.self)return;}catch(e){return;}"
    let originGuard = "try{if(location.origin===new URL(\"\(escapedAppURL)\").origin)return;}catch(e){}"
    let injectBody =
        "if(document.body){window.__SLICC_ELECTRON_OVERLAY__?.inject({appUrl:\"\(escapedAppURL)\"});}else{document.addEventListener('DOMContentLoaded',function(){window.__SLICC_ELECTRON_OVERLAY__?.inject({appUrl:\"\(escapedAppURL)\"});});}"
    let injectionCall = "(function(){\(frameGuard)\(originGuard)\(injectBody)})();"
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




enum OverlayInjectionAction: Equatable {
    
    case injectOnly
    
    
    case injectThenProbe
}

enum OverlayPostProbeAction: Equatable {
    
    case done
    
    
    case reloadWithBypass
}

enum OverlayPostReloadAction: Equatable {
    
    
    case noEscalationRequested
    
    case done
    
    
    case escalateToFetchProxy
}





final class ElectronOverlayInjector: @unchecked Sendable {
    private let cdpPort: Int
    private let servePort: Int
    private let projectRoot: URL
    private let session: URLSession
    private let logger: Logger
    private let probeDelayNanoseconds: UInt64
    
    
    
    
    
    private let thinBridge: ThinBridgeConfig?
    
    
    
    private let bridgeToken: String
    private let stateQueue = DispatchQueue(label: "slicc.browser.electron-overlay-injector")
    private var sessions: [String: OverlayTargetSession] = [:]
    private var cspBypassedURLs = Set<String>()
    
    
    
    
    
    private var egressBlockedURLs = Set<String>()
    private var pollTask: Task<Void, Never>?
    
    
    
    
    private var leaderTargetURL: String?

    
    
    
    
    
    var onEgressBlocked: (@Sendable (String) -> Void)?

    
    
    
    
    
    
    
    
    private let trayJoinUrl: String?

    
    
    
    
    private let testingThinBootstraps: ThinBootstrapSet?

    init(
        cdpPort: Int,
        servePort: Int,
        projectRoot: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        session: URLSession = .shared,
        logger: Logger = Logger(label: "slicc.browser.electron-overlay"),
        probeDelayNanoseconds: UInt64 = 1_500_000_000,
        thinBridge: ThinBridgeConfig,
        trayJoinUrl: String? = nil
    ) {
        self.cdpPort = cdpPort
        self.servePort = servePort
        self.projectRoot = projectRoot
        self.session = session
        self.logger = logger
        self.probeDelayNanoseconds = probeDelayNanoseconds
        self.thinBridge = thinBridge
        self.bridgeToken = thinBridge.bridgeToken
        self.trayJoinUrl = trayJoinUrl
        self.testingThinBootstraps = nil
    }

    
    
    
    
    init(
        _testingServePort servePort: Int,
        cdpPort: Int = 9223,
        thinBootstraps: ThinBootstrapSet? = nil,
        bridgeToken: String = "test-bridge-token",
        probeDelayNanoseconds: UInt64 = 20_000_000,
        session: URLSession = .shared,
        logger: Logger = Logger(label: "slicc.browser.electron-overlay")
    ) {
        self.cdpPort = cdpPort
        self.servePort = servePort
        self.projectRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        self.session = session
        self.logger = logger
        self.probeDelayNanoseconds = probeDelayNanoseconds
        self.thinBridge = nil
        self.bridgeToken = bridgeToken
        self.trayJoinUrl = nil
        self.testingThinBootstraps =
            thinBootstraps
            ?? ThinBootstrapSet(
                leader: "/* test-leader */", follower: "/* test-follower */", status: "/* test-status */")
    }

    func start() {
        let alreadyRunning = stateQueue.sync { pollTask != nil }
        guard !alreadyRunning else { return }
        logger.info(
            "Starting overlay injector polling loop",
            metadata: [
                "cdpPort": .stringConvertible(cdpPort),
                "servePort": .stringConvertible(servePort),
                "projectRoot": .string(projectRoot.path),
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
            Task { await session.gracefulShutdown() }
        }
    }

    
    
    
    static func openAction(alreadyCSPBypassed: Bool) -> OverlayInjectionAction {
        alreadyCSPBypassed ? .injectOnly : .injectThenProbe
    }

    
    
    static func postProbeAction(loaded: Bool) -> OverlayPostProbeAction {
        loaded ? .done : .reloadWithBypass
    }

    
    
    
    
    
    
    
    static func pollOverlayLoaded(
        budgetNanoseconds: UInt64,
        intervalNanoseconds: UInt64,
        shouldStop: @Sendable () -> Bool = { false },
        probe: @Sendable () async -> Bool
    ) async -> Bool {
        var elapsed: UInt64 = 0
        while true {
            if shouldStop() { return false }
            if await probe() { return true }
            if elapsed >= budgetNanoseconds { return false }
            let step =
                intervalNanoseconds == 0
                ? budgetNanoseconds - elapsed
                : min(intervalNanoseconds, budgetNanoseconds - elapsed)
            try? await Task.sleep(nanoseconds: step)
            elapsed &+= step
        }
    }

    
    
    
    static func postReloadAction(loaded: Bool, escalationRequested: Bool) -> OverlayPostReloadAction {
        guard escalationRequested else { return .noEscalationRequested }
        return loaded ? .done : .escalateToFetchProxy
    }

    
    
    
    
    
    
    
    static func shouldRecordBypassedAfter(probeAction action: OverlayPostProbeAction) -> Bool {
        action == .done
    }

    
    
    
    static func shouldRecordBypassedAfter(postReloadAction action: OverlayPostReloadAction) -> Bool {
        action == .done
    }

    
    
    
    
    static func shouldSkipNewDocumentRegistration(currentIdentifier: String?) -> Bool {
        currentIdentifier != nil
    }

    
    
    
    
    
    
    
    
    
    
    
    static func overlayEvictedProbeExpression() -> String {
        """
        (function() {
          try {
            var hasMarker = typeof window.__SLICC_ELECTRON_OVERLAY__ !== 'undefined';
            var hasRoot = !!document.getElementById('slicc-electron-overlay-root');
            return (hasMarker && !hasRoot) ? 'evicted' : 'ok';
          } catch (e) {
            return 'ok';
          }
        })()
        """
    }

    
    
    
    
    static func shouldReinjectForEvictionProbe(_ value: String) -> Bool {
        value == "evicted"
    }

    
    
    
    
    
    static func shouldAttemptEvictionReinject(closed: Bool, pendingReload: Bool) -> Bool {
        !closed && !pendingReload
    }

    
    
    
    
    
    
    
    
    
    static func shouldReinjectOnNavigationEvent(method: String, params: [String: Any]?) -> Bool {
        if method == "Page.navigatedWithinDocument" { return true }
        if method == "Page.frameNavigated" {
            let frame = params?["frame"] as? [String: Any]
            return frame?["parentId"] == nil
        }
        return false
    }

    
    
    
    
    
    static func overlayHostRemovalExpression() -> String {
        "try{window.__SLICC_ELECTRON_OVERLAY__&&window.__SLICC_ELECTRON_OVERLAY__.remove&&window.__SLICC_ELECTRON_OVERLAY__.remove();var e=document.getElementById('slicc-electron-overlay-root');if(e&&e.remove)e.remove();}catch(e){}"
    }

    
    
    
    
    
    
    
    
    
    
    
    static func overlayLoadedProbeExpression() -> String {
        """
        (function() {
          var host = document.getElementById('slicc-electron-overlay-root');
          if (!host || !host.shadowRoot) return 'no-host';
          var iframe = host.shadowRoot.querySelector('iframe');
          if (!iframe) return 'no-iframe';
          if (!iframe.src) return 'no-src';
          try {
            // Thin-bridge overlay is ALWAYS cross-origin (hosted webapp) vs the app
            // document. A committed cross-origin navigation makes this access THROW.
            // Any READABLE href means the cross-origin nav did NOT commit — still
            // about:blank, or swapped to chrome-error://chromewebdata/ by a CSP block —
            // so the overlay did NOT load and the setBypassCSP escalation must fire.
            var href = iframe.contentWindow && iframe.contentWindow.location ? iframe.contentWindow.location.href : '';
            return 'blank:' + href;
          } catch (e) {
            return 'ok';
          }
        })()
        """
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
        let bootstraps = try loadBootstrapScripts()
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(cdpPort)/json/list")!)
        request.timeoutInterval = 2
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw ElectronLaunchError.cdpNotAvailable("Failed to list Electron CDP targets on port \(cdpPort).")
        }

        let targets = try JSONDecoder().decode([ElectronInspectableTarget].self, from: data)
        let selectedTargets = selectBestOverlayTargets(targets)
        logger.debug(
            "syncTargets",
            metadata: [
                "totalTargets": .stringConvertible(targets.count),
                "selectedTargets": .stringConvertible(selectedTargets.count),
            ])
        let liveTargetIDs = Set(selectedTargets.compactMap(\.webSocketDebuggerURL))

        
        
        
        
        let liveTargetURLs = Set(selectedTargets.map(\.url))
        stateQueue.sync {
            if let current = leaderTargetURL, !liveTargetURLs.contains(current) {
                leaderTargetURL = nil
            }
        }

        
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

            let bootstrap = resolveBootstrapForTarget(target, bootstraps: bootstraps)
            let session = makeTargetSession(
                target: target, bootstrapScript: bootstrap, statusBootstrapScript: bootstraps.status)
            stateQueue.sync { sessions[targetID] = session }
            session.start()
        }
    }

    
    
    
    
    
    func resolveBootstrapForTarget(
        _ target: ElectronInspectableTarget,
        bootstraps: ThinBootstrapSet
    ) -> String {
        stateQueue.sync {
            if leaderTargetURL == target.url {
                return bootstraps.leader
            }
            if leaderTargetURL == nil {
                leaderTargetURL = target.url
                return bootstraps.leader
            }
            return bootstraps.follower
        }
    }

    
    
    func _testing_leaderTargetURL() -> String? {
        stateQueue.sync { leaderTargetURL }
    }

    
    
    
    func _testing_seedLeaderTargetURL(_ url: String?) {
        stateQueue.sync { leaderTargetURL = url }
    }

    
    
    
    @discardableResult
    func _testing_connectToTarget(_ target: ElectronInspectableTarget) throws -> OverlayTargetSession {
        let bootstraps = try loadBootstrapScripts()
        let bootstrap = resolveBootstrapForTarget(target, bootstraps: bootstraps)
        let session = makeTargetSession(
            target: target, bootstrapScript: bootstrap, statusBootstrapScript: bootstraps.status)
        if let targetID = target.webSocketDebuggerURL {
            stateQueue.sync { sessions[targetID] = session }
        }
        session.start()
        return session
    }

    
    
    func _testing_closeConnections() {
        let snapshot: [OverlayTargetSession] = stateQueue.sync {
            let value = Array(sessions.values)
            sessions.removeAll()
            return value
        }
        for session in snapshot {
            session.stop()
        }
    }

    private func makeTargetSession(
        target: ElectronInspectableTarget, bootstrapScript: String, statusBootstrapScript: String
    ) -> OverlayTargetSession {
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
        let isAlreadyEgressBlocked: @Sendable (String) -> Bool = { [weak self] url in
            guard let self else { return false }
            return self.stateQueue.sync { self.egressBlockedURLs.contains(url) }
        }
        let recordEgressBlocked: @Sendable (String) -> Void = { [weak self] url in
            self?.markEgressBlockedAndNotify(url)
        }
        return OverlayTargetSession(
            target: target,
            bootstrapScript: bootstrapScript,
            statusBootstrapScript: statusBootstrapScript,
            servePort: servePort,
            bridgeToken: bridgeToken,
            session: session,
            logger: logger,
            probeDelayNanoseconds: probeDelayNanoseconds,
            isAlreadyBypassed: isAlreadyBypassed,
            recordBypassed: recordBypassed,
            isAlreadyEgressBlocked: isAlreadyEgressBlocked,
            recordEgressBlocked: recordEgressBlocked,
            onClose: onClose
        )
    }

    
    
    func _testing_bypassedURLs() -> Set<String> {
        stateQueue.sync { cspBypassedURLs }
    }

    
    
    func _testing_seedBypassedURL(_ url: String) {
        stateQueue.sync { _ = cspBypassedURLs.insert(url) }
    }

    
    
    func _testing_egressBlockedURLs() -> Set<String> {
        stateQueue.sync { egressBlockedURLs }
    }

    
    
    func _testing_seedEgressBlockedURL(_ url: String) {
        stateQueue.sync { _ = egressBlockedURLs.insert(url) }
    }

    
    
    
    
    func markEgressBlockedAndNotify(_ url: String) {
        let shouldNotify: Bool = stateQueue.sync {
            let wasEmpty = egressBlockedURLs.isEmpty
            egressBlockedURLs.insert(url)
            return wasEmpty
        }
        if shouldNotify { onEgressBlocked?(url) }
    }

    
    
    
    
    
    
    func loadBootstrapScripts() throws -> ThinBootstrapSet {
        
        if let testingThin = testingThinBootstraps {
            return testingThin
        }

        guard let thinBridge else {
            throw ElectronLaunchError.overlayConfigUnresolved(
                "Cannot build Electron overlay bootstrap: no thin-bridge config resolved. "
                    + "The thin-bridge overlay requires a per-process bridge token "
                    + "(set SLICC_HOSTED_LEADER_ORIGIN to enable thin-electron mode)."
            )
        }

        let bundleSource = try loadOverlayBundleSource()
        
        
        
        
        let leader = buildElectronOverlayBootstrapScript(
            bundleSource: bundleSource,
            appURL: buildThinOverlayAppURL(
                options: ThinOverlayURLOptions(
                    config: thinBridge, role: .leader, trayJoinUrl: trayJoinUrl ?? "")
            )
        )
        let follower = buildElectronOverlayBootstrapScript(
            bundleSource: bundleSource,
            appURL: buildThinOverlayAppURL(
                options: ThinOverlayURLOptions(config: thinBridge, role: .follower, trayJoinUrl: "")
            )
        )
        let status = buildElectronOverlayStatusBootstrapScript(
            bundleSource: bundleSource,
            statusMessage: overlayStatusMessageEgressBlocked
        )
        return ThinBootstrapSet(leader: leader, follower: follower, status: status)
    }

    private func loadOverlayBundleSource() throws -> String {
        let fileManager = FileManager.default
        let candidates = [
            projectRoot,
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
            projectRoot.deletingLastPathComponent(),
        ]
        let relativePaths = ["dist/ui/electron-overlay.js", "dist/ui/electron-overlay-entry.js"]

        for root in candidates {
            for relativePath in relativePaths {
                let candidate = root.appendingPathComponent(relativePath)
                if fileManager.fileExists(atPath: candidate.path) {
                    return try String(contentsOf: candidate, encoding: .utf8)
                }
            }
        }

        logger.warning("Electron overlay bundle not found; using inline fallback")
        return inlineFallbackOverlayBundle()
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
