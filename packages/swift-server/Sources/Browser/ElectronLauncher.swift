import AppKit
import Foundation
import Logging

private let electronOverlaySyncIntervalNanoseconds: UInt64 = 1_500_000_000

/// Cadence of the per-session overlay presence re-check. Covers SPAs that
/// re-render their DOM root (evicting `#slicc-electron-overlay-root`) without
/// emitting any navigation event for the event-driven re-injection to hook.
/// Mirrors `ELECTRON_OVERLAY_PRESENCE_CHECK_INTERVAL_MS` in node-server's
/// `electron-controller.ts`.
private let electronOverlayPresenceCheckIntervalNanoseconds: UInt64 = 2_000_000_000

/// First-attempt overlay probe cadence + budget. A single-shot probe could
/// fire while the overlay iframe was still at `about:blank` — before its
/// cross-origin navigation committed — yielding a false "blocked" that tripped
/// a needless CSP-bypass reload. On swift that reload then connected the `/cdp`
/// bridge client, starving the injector's own CDP session and looping forever.
/// Polling catches the cross-origin commit the instant it happens so a
/// CSP-bearing app (AEM, Slack) renders on Phase-1 and escalation only fires
/// when the frame genuinely never commits.
private let overlayFirstProbeBudgetNanoseconds: UInt64 = 3_000_000_000
private let overlayFirstProbeIntervalNanoseconds: UInt64 = 200_000_000

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

// MARK: - Path B: thin-bridge launch URL

/// Query-param name used to mark the role of an overlay tab on the hosted
/// launcher URL. The pinned leader carries `role=leader`; auto-follow
/// followers carry `role=follower`. Mirrors `BRIDGE_ROLE_QUERY_PARAM` in
/// `packages/node-server/src/electron-controller.ts`.
let bridgeRoleQueryParam = "role"
let bridgeRoleLeader = "leader"
let bridgeRoleFollower = "follower"

/// Thin-bridge coordinates for the Electron overlay. When supplied to
/// `ElectronOverlayInjector`, the injected overlay loads from a
/// sliccy.ai-hosted launcher (Path B) and dials back to the local `/cdp`
/// WebSocket using the per-process bridge token. Mirrors
/// `ThinBridgeConfig` in `packages/node-server/src/electron-controller.ts`.
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

    init(config: ThinBridgeConfig, role: OverlayRole, activeTab: String? = nil) {
        self.config = config
        self.role = role
        self.activeTab = activeTab
    }
}

/// Build the hosted launcher URL for an overlay injection. Mirrors the
/// standalone Path A launch-URL shape (`bridge`, `bridgeToken` query
/// params) with one Electron-specific addition: a `role` param that pins
/// the first injected tab as the leader and marks every subsequent tab as
/// an auto-follow follower. Byte-for-byte parity with
/// `buildThinOverlayAppUrl` in node-server's `electron-controller.ts`.
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
    components.queryItems = items
    return components.string ?? "\(trimmed)/electron"
}

/// Resolve the hosted leader origin Chrome / Electron should open in thin
/// mode. Prefers explicit overrides (`SLICC_HOSTED_LEADER_ORIGIN`, then
/// `WORKER_BASE_URL`) so dev can point at staging; defaults to production
/// `https://www.sliccy.ai`. Trailing slashes are stripped so callers can
/// safely concatenate paths. Mirrors `resolveHostedLeaderOrigin` in
/// `packages/node-server/src/electron-controller.ts`.
func resolveHostedLeaderOrigin(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
    let explicit = environment["SLICC_HOSTED_LEADER_ORIGIN"] ?? environment["WORKER_BASE_URL"]
    if let explicit, !explicit.isEmpty {
        return explicit.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
    }
    return "https://www.sliccy.ai"
}

/// Pre-built thin-mode bootstrap pair — one per overlay role. The
/// injector picks `leader` for the first injected target and `follower`
/// for every subsequent target. Mirrors `ThinBootstrapSet` in
/// `packages/node-server/src/electron-controller.ts`.
struct ThinBootstrapSet: Sendable {
    let leader: String
    let follower: String
}

func buildElectronOverlayBootstrapScript(bundleSource: String, appURL: String) -> String {
    let escapedAppURL = appURL.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    // Gate the inject call on a top-frame + non-overlay-origin check so the
    // bootstrap no-ops when `Page.addScriptToEvaluateOnNewDocument` runs it
    // inside our own overlay iframe at `http://localhost:<servePort>/electron`
    // (or any other subframe). Without this, the Slicc webapp inside the
    // overlay iframe re-runs the bootstrap and injects another launcher
    // inside itself, recursing up to N levels deep. node-server doesn't hit
    // this because it doesn't register an all-frames script.
    let frameGuard = "try{if(window.top!==window.self)return;}catch(e){return;}"
    let originGuard = "try{if(location.origin===new URL(\"\(escapedAppURL)\").origin)return;}catch(e){}"
    let injectBody = "if(document.body){window.__SLICC_ELECTRON_OVERLAY__?.inject({appUrl:\"\(escapedAppURL)\"});}else{document.addEventListener('DOMContentLoaded',function(){window.__SLICC_ELECTRON_OVERLAY__?.inject({appUrl:\"\(escapedAppURL)\"});});}"
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
    /// Thin-bridge config: the overlay loads from a sliccy.ai-hosted
    /// launcher with a per-process bridge token + role tag. This is the
    /// only overlay path — the legacy bundled-UI overlay (Path A) served
    /// from the local serve port was retired. Nil only in the test-only
    /// init, which supplies `testingThinBootstraps` instead.
    private let thinBridge: ThinBridgeConfig?
    private let stateQueue = DispatchQueue(label: "slicc.browser.electron-overlay-injector")
    private var sessions: [String: OverlayTargetSession] = [:]
    private var cspBypassedURLs = Set<String>()
    private var pollTask: Task<Void, Never>?
    /// URL of the target currently elected as the pinned leader. Cleared
    /// by `syncTargets` when that target disappears so the next injection
    /// re-elects a fresh leader. Mirrors node-server's `leaderTargetUrl`
    /// in `electron-controller.ts`.
    private var leaderTargetURL: String?

    /// Test-only injection seam: when set, `loadBootstrapScripts()` returns
    /// this pair instead of reading bundle files. Mirrors node-server's
    /// `_createForTesting` bootstrap override so unit tests can drive the
    /// per-target connect flow without bundle I/O.
    private let testingThinBootstraps: ThinBootstrapSet?

    /// Test-only injection seam: when set, `loadOverlayBundleSource()` returns
    /// this instead of fetching from the hosted origin — keeps unit tests
    /// offline while still exercising the bootstrap assembly + injection call.
    private let testingOverlayBundleSource: String?

    /// In-memory cache of the fetched overlay bundle so the network round-trip
    /// happens at most once per process (subsequent `syncTargets` poll cycles
    /// reuse it). Guarded by `stateQueue`. The inline fallback is never cached
    /// here so a later poll can still recover the real bundle once the hosted
    /// origin becomes reachable.
    private var cachedOverlayBundleSource: String?

    init(
        cdpPort: Int,
        servePort: Int,
        projectRoot: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        session: URLSession = .shared,
        logger: Logger = Logger(label: "slicc.browser.electron-overlay"),
        probeDelayNanoseconds: UInt64 = 1_500_000_000,
        thinBridge: ThinBridgeConfig,
        testingOverlayBundleSource: String? = nil
    ) {
        self.cdpPort = cdpPort
        self.servePort = servePort
        self.projectRoot = projectRoot
        self.session = session
        self.logger = logger
        self.probeDelayNanoseconds = probeDelayNanoseconds
        self.thinBridge = thinBridge
        self.testingThinBootstraps = nil
        self.testingOverlayBundleSource = testingOverlayBundleSource
    }

    /// Test-only init that skips bundle loading and lets tests drive the
    /// per-target connect flow directly with controllable bootstrap
    /// markers + probe delay. Mirrors node-server's
    /// `ElectronOverlayInjector._createForTesting` factory.
    init(
        _testingServePort servePort: Int,
        cdpPort: Int = 9223,
        thinBootstraps: ThinBootstrapSet? = nil,
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
        self.testingThinBootstraps = thinBootstraps
            ?? ThinBootstrapSet(leader: "/* test-leader */", follower: "/* test-follower */")
        self.testingOverlayBundleSource = nil
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
        // Best-effort graceful teardown so a slicc-server restart against
        // the same Electron app starts with a clean DOM (no stale overlay
        // host element from the prior session). The async detach is fire-
        // and-forget — `stop()` itself is sync so we don't block on it.
        for session in toClose {
            Task { await session.gracefulShutdown() }
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

    /// Poll `probe` every `intervalNanoseconds` until it reports the overlay
    /// iframe loaded or `budgetNanoseconds` elapses, returning `true` the
    /// instant the committed cross-origin navigation is observed. `shouldStop`
    /// lets the caller bail early on cancellation/teardown. Replaces the
    /// single-shot first-attempt probe so a variable cross-origin commit time
    /// (fast on Slack, slower on AEM Desktop) no longer reads as a false
    /// "blocked" and trips a spurious CSP-bypass reload.
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
            let step = intervalNanoseconds == 0
                ? budgetNanoseconds - elapsed
                : min(intervalNanoseconds, budgetNanoseconds - elapsed)
            try? await Task.sleep(nanoseconds: step)
            elapsed &+= step
        }
    }

    /// Decide whether to escalate to the Fetch proxy after the bypassed
    /// reload. Mirrors node-server: escalation only fires when the original
    /// `injectThenProbe` path requested it (i.e. the very first reload).
    static func postReloadAction(loaded: Bool, escalationRequested: Bool) -> OverlayPostReloadAction {
        guard escalationRequested else { return .noEscalationRequested }
        return loaded ? .done : .escalateToFetchProxy
    }

    /// Whether to record the target URL as CSP-bypassed after a post-probe
    /// decision. The reload-with-bypass path must NOT record yet — if the CDP
    /// session disconnects mid-reload (observed on AEM Desktop where the
    /// renderer recreates its execution context during bootstrap), the next
    /// reconnect would see `alreadyBypassed=true` and skip the reload entirely
    /// via `openAction`, leaving the iframe permanently blocked. Only record
    /// once we have confirmed the iframe actually loaded.
    static func shouldRecordBypassedAfter(probeAction action: OverlayPostProbeAction) -> Bool {
        action == .done
    }

    /// Whether to record the target URL as CSP-bypassed after a post-reload
    /// decision. Same rationale as `probeAction` — only record on confirmed
    /// `.done` (iframe loaded after the bypassed reload).
    static func shouldRecordBypassedAfter(postReloadAction action: OverlayPostReloadAction) -> Bool {
        action == .done
    }

    /// Whether to skip registering the new-document overlay bootstrap. We
    /// only need it registered once per `OverlayTargetSession`; re-running
    /// `Page.addScriptToEvaluateOnNewDocument` would install a duplicate
    /// hook and waste CDP work.
    static func shouldSkipNewDocumentRegistration(currentIdentifier: String?) -> Bool {
        currentIdentifier != nil
    }

    /// JS probe that reports `'evicted'` only when the overlay marker
    /// (`window.__SLICC_ELECTRON_OVERLAY__`) is still present — the bootstrap
    /// ran at least once on this document — but `#slicc-electron-overlay-root`
    /// is gone, which is what an SPA framework (React/Vue) does when it
    /// re-renders the DOM root out from under the overlay on an in-page route
    /// change. Returns `'ok'` in every other state so re-injection is gated to
    /// the genuine eviction case and never loops while the host element is
    /// still attached. A full document replacement wipes the marker too, so
    /// that case reports `'ok'` here and is covered by the new-document hook
    /// instead. Mirrors `OVERLAY_EVICTED_PROBE_EXPRESSION` in node-server's
    /// `electron-controller.ts`.
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

    /// Classify the eviction probe result: re-inject only on the exact
    /// `'evicted'` signal so an error or healthy state never triggers a
    /// re-inject. Mirrors node-server's `probeOverlayEvicted` resolving `true`
    /// only when the probe returns `'evicted'`.
    static func shouldReinjectForEvictionProbe(_ value: String) -> Bool {
        value == "evicted"
    }

    /// Gate the eviction re-inject on a live, non-reloading session: skip while
    /// the socket is closed or a CSP-bypass reload / Fetch-proxy escalation owns
    /// injection (`pendingReload`). Mirrors node-server's `ws.readyState ===
    /// OPEN && !state.pendingReload` guard, applied both before and after the
    /// probe so a reload that starts mid-probe is respected.
    static func shouldAttemptEvictionReinject(closed: Bool, pendingReload: Bool) -> Bool {
        !closed && !pendingReload
    }

    /// Whether a CDP navigation event should drive an eviction re-inject.
    /// `Page.navigatedWithinDocument` (history.pushState / hashchange) creates
    /// no new document, so the new-document hook never fires; the main-frame
    /// `Page.frameNavigated` covers load-driven navs of the existing target.
    /// Subframe navigations never touch the top-level overlay, so they are
    /// ignored. The eviction probe keeps the main-frame full-navigation case a
    /// no-op (its marker is wiped, so the new-document hook owns it). Mirrors
    /// node-server's `navigatedWithinDocument || (frameNavigated && main-frame)`
    /// trigger.
    static func shouldReinjectOnNavigationEvent(method: String, params: [String: Any]?) -> Bool {
        if method == "Page.navigatedWithinDocument" { return true }
        if method == "Page.frameNavigated" {
            let frame = params?["frame"] as? [String: Any]
            return frame?["parentId"] == nil
        }
        return false
    }

    /// JS expression that removes the overlay host element from the
    /// document on a graceful session teardown so a reopen starts with a
    /// clean DOM. Calls the overlay's own `remove()` API first and falls
    /// back to a direct DOM removal so a stale bundle that doesn't expose
    /// `remove` is still cleaned up.
    static func overlayHostRemovalExpression() -> String {
        "try{window.__SLICC_ELECTRON_OVERLAY__&&window.__SLICC_ELECTRON_OVERLAY__.remove&&window.__SLICC_ELECTRON_OVERLAY__.remove();var e=document.getElementById('slicc-electron-overlay-root');if(e&&e.remove)e.remove();}catch(e){}"
    }

    /// JS probe that reports whether the overlay iframe actually loaded.
    /// Walks the `<slicc-launcher>` host's (open) shadow root to find the
    /// iframe depth-agnostically, then classifies by cross-origin
    /// reachability: the thin-bridge overlay is ALWAYS a different origin
    /// (hosted webapp) than the app document, so a committed cross-origin
    /// navigation makes `iframe.contentWindow.location.href` THROW — that
    /// throw is the ONLY success signal. Any READABLE href (`about:blank`,
    /// `''`, or a CSP-blocked swap to `chrome-error://chromewebdata/`) means
    /// the cross-origin nav did NOT commit, so the overlay did not load and the
    /// setBypassCSP escalation must fire. Returns `'ok'` only from the catch;
    /// otherwise `'no-host' / 'no-iframe' / 'no-src' / 'blank:<href>'`.
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
        let bootstraps = try await loadBootstrapScripts()
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

        // Drop the elected leader if its target is no longer present so the
        // next injection re-elects. Without this a stale leaderTargetURL
        // would block every future tab from becoming the pinned leader
        // after the original leader closed.
        let liveTargetURLs = Set(selectedTargets.map(\.url))
        stateQueue.sync {
            if let current = leaderTargetURL, !liveTargetURLs.contains(current) {
                leaderTargetURL = nil
            }
        }

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

            let bootstrap = resolveBootstrapForTarget(target, bootstraps: bootstraps)
            let session = makeTargetSession(target: target, bootstrapScript: bootstrap)
            stateQueue.sync { sessions[targetID] = session }
            session.start()
        }
    }

    /// Pick the bootstrap script for `target`, electing the leader on
    /// first use. Same target URL ↔ same role across reconnects so a page
    /// that bounces its CDP session stays the leader (no re-election on
    /// transient drops, only on `syncTargets` cleanup). Mirrors node-
    /// server's `resolveBootstrapForTarget` in `electron-controller.ts`.
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

    /// Snapshot the elected leader target URL (nil when no leader has
    /// been elected). Mirrors node-server's `_testingLeaderTargetUrl()`.
    func _testing_leaderTargetURL() -> String? {
        stateQueue.sync { leaderTargetURL }
    }

    /// Seed the elected leader so the next injection elects a follower
    /// against a known target. Mirrors node-server's
    /// `_testingSeedLeaderTargetUrl()`.
    func _testing_seedLeaderTargetURL(_ url: String?) {
        stateQueue.sync { leaderTargetURL = url }
    }

    /// Test-only: drive the per-target connect flow without going
    /// through `start()`. Returns the freshly-created session so callers
    /// can stop it explicitly (no polling loop is running in tests).
    @discardableResult
    func _testing_connectToTarget(_ target: ElectronInspectableTarget) async throws -> OverlayTargetSession {
        let bootstraps = try await loadBootstrapScripts()
        let bootstrap = resolveBootstrapForTarget(target, bootstraps: bootstraps)
        let session = makeTargetSession(target: target, bootstrapScript: bootstrap)
        if let targetID = target.webSocketDebuggerURL {
            stateQueue.sync { sessions[targetID] = session }
        }
        session.start()
        return session
    }

    /// Test-only: close any sessions opened by `_testing_connectToTarget`.
    /// Mirrors node-server's `_testingCloseConnections`.
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

    /// Build the thin-bridge bootstrap pair loaded once per `syncTargets`
    /// cycle: leader/follower variants whose only difference is the `role=`
    /// query param on the hosted launcher URL. This is the only overlay
    /// path — the legacy bundled-overlay bootstrap was retired. Throws when
    /// no thin-bridge config is available (fail fast rather than serving a
    /// now-removed bundled overlay).
    func loadBootstrapScripts() async throws -> ThinBootstrapSet {
        // Test-only override path: skip bundle I/O entirely.
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

        let bundleSource = await loadOverlayBundleSource()
        let leader = buildElectronOverlayBootstrapScript(
            bundleSource: bundleSource,
            appURL: buildThinOverlayAppURL(
                options: ThinOverlayURLOptions(config: thinBridge, role: .leader)
            )
        )
        let follower = buildElectronOverlayBootstrapScript(
            bundleSource: bundleSource,
            appURL: buildThinOverlayAppURL(
                options: ThinOverlayURLOptions(config: thinBridge, role: .follower)
            )
        )
        return ThinBootstrapSet(leader: leader, follower: follower)
    }

    /// Resolve the overlay bundle source. The launcher treats the hosted
    /// origin (`https://www.sliccy.ai`) as a CDN: the overlay bootstrap is
    /// fetched at runtime and cached on disk, so the macOS `.app` bundle no
    /// longer embeds `dist/ui/electron-overlay-entry.js` and the Swift build
    /// is fully decoupled from the webapp build. Resolution order: in-memory
    /// cache → network fetch (cached to disk on success) → on-disk cache →
    /// inline fallback. The inline fallback is never cached so later poll
    /// cycles keep retrying the network.
    private func loadOverlayBundleSource() async -> String {
        if let testingOverlayBundleSource {
            return testingOverlayBundleSource
        }
        if let cached = stateQueue.sync(execute: { cachedOverlayBundleSource }) {
            return cached
        }

        let origin = thinBridge?.hostedLeaderOrigin ?? resolveHostedLeaderOrigin()
        let trimmed = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
        if let url = URL(string: "\(trimmed)/electron-overlay-entry.js") {
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 10
                let (data, response) = try await session.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                if status == 200,
                   let source = String(data: data, encoding: .utf8),
                   !source.isEmpty {
                    stateQueue.sync { cachedOverlayBundleSource = source }
                    writeOverlayBundleCache(source)
                    logger.info("Fetched Electron overlay bundle from hosted origin", metadata: [
                        "url": .string(url.absoluteString),
                        "bytes": .stringConvertible(data.count)
                    ])
                    return source
                }
                logger.warning("Hosted overlay fetch returned non-200; falling back", metadata: [
                    "url": .string(url.absoluteString),
                    "status": .stringConvertible(status)
                ])
            } catch {
                logger.warning("Hosted overlay fetch failed; falling back", metadata: [
                    "url": .string(url.absoluteString),
                    "error": .string(error.localizedDescription)
                ])
            }
        }

        if let cached = readOverlayBundleCache() {
            stateQueue.sync { cachedOverlayBundleSource = cached }
            logger.info("Using on-disk Electron overlay cache (hosted origin unreachable)")
            return cached
        }

        logger.warning("Electron overlay bundle unavailable; using inline fallback")
        return inlineFallbackOverlayBundle()
    }

    /// On-disk cache location for the fetched overlay bundle: the user caches
    /// directory under `ai.sliccy.slicc`. Persists between launches so an
    /// offline start still renders the real overlay rather than the minimal
    /// inline fallback.
    private func overlayBundleCacheURL() -> URL? {
        guard let caches = try? FileManager.default.url(
            for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return nil }
        return caches
            .appendingPathComponent("ai.sliccy.slicc", isDirectory: true)
            .appendingPathComponent("electron-overlay-entry.js")
    }

    private func readOverlayBundleCache() -> String? {
        guard let url = overlayBundleCacheURL(),
              FileManager.default.fileExists(atPath: url.path),
              let source = try? String(contentsOf: url, encoding: .utf8),
              !source.isEmpty else { return nil }
        return source
    }

    private func writeOverlayBundleCache(_ source: String) {
        guard let url = overlayBundleCacheURL() else { return }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try source.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            logger.warning("Failed to write Electron overlay cache", metadata: [
                "error": .string(error.localizedDescription)
            ])
        }
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
    private let commandTimeoutNanoseconds: UInt64
    private let presenceCheckIntervalNanoseconds: UInt64
    private let isAlreadyBypassed: @Sendable (String) -> Bool
    private let recordBypassed: @Sendable (String) -> Void
    private let onClose: @Sendable (String) -> Void

    private let stateQueue = DispatchQueue(label: "slicc.browser.electron-overlay-session")
    private var socket: URLSessionWebSocketTask?
    private var recvTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var presenceTask: Task<Void, Never>?
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
        commandTimeoutNanoseconds: UInt64 = 10_000_000_000,
        presenceCheckIntervalNanoseconds: UInt64 = electronOverlayPresenceCheckIntervalNanoseconds,
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
        self.commandTimeoutNanoseconds = commandTimeoutNanoseconds
        self.presenceCheckIntervalNanoseconds = presenceCheckIntervalNanoseconds
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
        // Periodic presence re-check: covers SPAs that re-render their DOM root
        // (evicting the overlay) without firing a navigation event. Cancelled
        // by `stop()` so it never outlives the session.
        let presence = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.runPresenceCheckLoop()
        }
        stateQueue.sync {
            recvTask = recv
            connectTask = connect
            presenceTask = presence
        }
    }

    private struct StopSnapshot {
        let wasAlreadyClosed: Bool
        let socket: URLSessionWebSocketTask?
        let recvTask: Task<Void, Never>?
        let connectTask: Task<Void, Never>?
        let presenceTask: Task<Void, Never>?
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
                presenceTask: presenceTask,
                waiters: responseWaiters
            )
            socket = nil
            recvTask = nil
            connectTask = nil
            presenceTask = nil
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
        snapshot.presenceTask?.cancel()
    }

    /// Graceful teardown variant: best-effort sends a Runtime.evaluate that
    /// removes the overlay host element from the document, then calls
    /// `stop()`. Use this on a clean shutdown path so a slicc-server restart
    /// against the same Electron app starts with a fresh DOM. The eval is
    /// fire-and-forget; if the socket is already dead this is a no-op.
    func gracefulShutdown() async {
        let alreadyClosed = stateQueue.sync { closed }
        if alreadyClosed { return }
        _ = await sendCommand(method: "Runtime.evaluate", params: [
            "expression": ElectronOverlayInjector.overlayHostRemovalExpression(),
            "awaitPromise": false
        ])
        stop()
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
            let loaded = await ElectronOverlayInjector.pollOverlayLoaded(
                budgetNanoseconds: overlayFirstProbeBudgetNanoseconds,
                intervalNanoseconds: overlayFirstProbeIntervalNanoseconds,
                shouldStop: { [weak self] in Task.isCancelled || (self?.isClosed() ?? true) },
                probe: { [weak self] in await self?.probeOverlayLoaded() ?? false }
            )
            if Task.isCancelled || isClosed() { return }
            await handlePostProbe(loaded: loaded)
        }
    }

    private func handlePostProbe(loaded: Bool) async {
        let decision = ElectronOverlayInjector.postProbeAction(loaded: loaded)
        if ElectronOverlayInjector.shouldRecordBypassedAfter(probeAction: decision) {
            recordBypassed(target.url)
        }
        switch decision {
        case .done:
            logger.info("Overlay iframe loaded successfully — no CSP reload needed", metadata: ["target": .string(target.url)])
        case .reloadWithBypass:
            // Deliberately do NOT recordBypassed yet — if the CDP session
            // disconnects mid-reload (AEM Desktop's bootstrap recreates the
            // execution context, which closes our WS), the next reconnect
            // needs to re-run the reload path. Only record once
            // `handleLoadEventFired` confirms the iframe loaded.
            logger.info("Overlay iframe blocked by CSP, reloading with bypass", metadata: ["target": .string(target.url)])
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
                    let pendingCount = stateQueue.sync { responseWaiters.count }
                    logger.warning("Overlay session disconnected, failing in-flight CDP requests", metadata: [
                        "target": .string(target.url),
                        "error": .string(error.localizedDescription),
                        "pendingWaiters": .stringConvertible(pendingCount)
                    ])
                }
                let targetID = target.webSocketDebuggerURL ?? target.url
                // Fail all pending continuations and cancel the socket so the
                // `runConnectFlow` (or `handleLoadEventFired`) awaiting a
                // response unblocks instead of hanging forever. The injector's
                // polling loop will then reconnect with a fresh session.
                stop()
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
            // In-page SPA route change (history.pushState / hashchange) or a
            // main-frame load-driven nav: re-inject the role bootstrap if the
            // host element was evicted. The eviction probe keeps a full
            // main-frame navigation a no-op (its marker is wiped, so the
            // new-document hook owns it).
            if ElectronOverlayInjector.shouldReinjectOnNavigationEvent(method: method, params: params) {
                // Dispatch off the receive loop so it keeps consuming
                // `receive()` and can resolve the eviction probe's CDP response.
                // Awaiting `reinjectIfEvicted` inline here would deadlock: the
                // probe registers a `responseWaiters` continuation that only the
                // receive loop can resolve, so the probe would stall until its
                // command timeout. Mirrors node-server's fire-and-forget
                // `void this.reinjectIfEvicted(...)` from its event handler.
                Task { [weak self] in await self?.reinjectIfEvicted() }
            }
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
        if ElectronOverlayInjector.shouldRecordBypassedAfter(postReloadAction: decision) {
            recordBypassed(target.url)
        }
        switch decision {
        case .done, .noEscalationRequested:
            logger.info("Overlay iframe loaded successfully after CSP reload — no proxy needed", metadata: [
                "target": .string(target.url),
                "decision": .string(String(describing: decision))
            ])
        case .escalateToFetchProxy:
            logger.warning("Overlay iframe still blocked after bypass reload — escalating to Fetch proxy", metadata: [
                "target": .string(target.url)
            ])
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
            // Fire-and-forget to match node-server (electron-controller.ts
            // `send('Fetch.fulfillRequest', ...)` with no await). Awaiting
            // here is what previously tripped the 10s command timeout on
            // every cycle, producing the "CDP command timed out" /
            // "Client disconnected" loop in AEM Desktop.
            _ = await sendCommand(method: "Fetch.fulfillRequest", params: [
                "requestId": requestId,
                "responseCode": proxied.statusCode,
                "responseHeaders": proxied.headers,
                "body": proxied.bodyBase64
            ])
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

    /// Periodic presence re-check loop: every `presenceCheckIntervalNanoseconds`
    /// (after an initial interval, matching node-server's `setInterval` cadence)
    /// re-inject the overlay if it was evicted. Covers SPAs that re-render their
    /// DOM root without firing any navigation event the handler could hook.
    private func runPresenceCheckLoop() async {
        while !Task.isCancelled && !isClosed() {
            try? await Task.sleep(nanoseconds: presenceCheckIntervalNanoseconds)
            if Task.isCancelled || isClosed() { return }
            await reinjectIfEvicted()
        }
    }

    /// Re-inject the overlay if (and only if) it was evicted from this
    /// already-connected target — an in-page SPA route change or DOM-root
    /// re-render that removed `#slicc-electron-overlay-root` while the
    /// `__SLICC_ELECTRON_OVERLAY__` marker persists. Gated on the eviction probe
    /// so it is idempotent and never loops while the host element is still
    /// attached, and skipped while the CSP-bypass reload / Fetch-proxy
    /// escalation owns injection (`pendingReload`). Re-uses this session's
    /// existing role bootstrap, so no leader/follower re-election occurs.
    /// Mirrors node-server's `reinjectIfEvicted`.
    private func reinjectIfEvicted() async {
        let before: (closed: Bool, pendingReload: Bool) = stateQueue.sync { (closed, pendingReload) }
        guard ElectronOverlayInjector.shouldAttemptEvictionReinject(
            closed: before.closed,
            pendingReload: before.pendingReload
        ) else { return }
        let evicted = await probeOverlayEvicted()
        let after: (closed: Bool, pendingReload: Bool) = stateQueue.sync { (closed, pendingReload) }
        guard evicted, ElectronOverlayInjector.shouldAttemptEvictionReinject(
            closed: after.closed,
            pendingReload: after.pendingReload
        ) else { return }
        logger.info("Overlay evicted, re-injecting", metadata: ["target": .string(target.url)])
        await sendBootstrap()
    }

    /// Evaluate `overlayEvictedProbeExpression()` and resolve `true` only when
    /// the overlay marker is present but the host element is gone — the
    /// SPA-DOM-root eviction case re-injection must repair. Mirrors
    /// node-server's `probeOverlayEvicted`.
    private func probeOverlayEvicted() async -> Bool {
        let result = await sendCommand(method: "Runtime.evaluate", params: [
            "expression": ElectronOverlayInjector.overlayEvictedProbeExpression(),
            "awaitPromise": false,
            "returnByValue": true
        ], awaitResponse: true)
        let value = (result?["result"] as? [String: Any])?["value"] as? String ?? ""
        return ElectronOverlayInjector.shouldReinjectForEvictionProbe(value)
    }

    /// Install the bootstrap as a `Page.addScriptToEvaluateOnNewDocument`
    /// hook so it re-runs automatically on every new document — including
    /// ones the host app's own bootstrap may create after our reload (the
    /// AEM Desktop case where the re-evaluate after `Page.loadEventFired`
    /// would otherwise race a fresh document and not stick).
    private func registerNewDocumentScript() async {
        let currentIdentifier = stateQueue.sync { addedScriptIdentifier }
        if ElectronOverlayInjector.shouldSkipNewDocumentRegistration(currentIdentifier: currentIdentifier) {
            logger.debug("Overlay bootstrap already registered, skipping", metadata: [
                "target": .string(target.url),
                "identifier": .string(currentIdentifier ?? "")
            ])
            return
        }
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
        // Mirrors node-server's `probeOverlayIframeLoaded`: walks the
        // `<slicc-launcher>` host → (open) shadowRoot → iframe and only reports
        // success when the iframe actually navigated away from `about:blank`.
        let expression = ElectronOverlayInjector.overlayLoadedProbeExpression()
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
                // Belt-and-suspenders timeout so a wedged CDP call (e.g. the
                // socket silently buffering against a dead peer) cannot stall
                // the connect/post-reload pipeline. The receive-loop's
                // disconnect handler also fails pending waiters via `stop()`,
                // so the timeout is the fallback when no error surfaces.
                let timeoutNs = self.commandTimeoutNanoseconds
                let methodName = method
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: timeoutNs)
                    guard let self else { return }
                    let waiter: CheckedContinuation<[String: Any]?, Never>? = self.stateQueue.sync {
                        self.responseWaiters.removeValue(forKey: id)
                    }
                    if let waiter {
                        self.logger.warning("CDP command timed out, failing waiter", metadata: [
                            "target": .string(self.target.url),
                            "method": .string(methodName),
                            "id": .stringConvertible(id)
                        ])
                        waiter.resume(returning: nil)
                    }
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

    /// Test-only: register a synthetic pending waiter (no socket I/O) so a
    /// unit test can drive `stop()` and assert the continuation resolves
    /// with `nil`. Verifies the receive-loop disconnect path that previously
    /// hung the connect/post-reload pipeline.
    func _testing_awaitSyntheticWaiter() async -> [String: Any]? {
        await withCheckedContinuation { (cont: CheckedContinuation<[String: Any]?, Never>) in
            stateQueue.sync {
                messageIdCounter += 1
                responseWaiters[messageIdCounter] = cont
            }
        }
    }

    /// Test-only: current count of registered response waiters.
    func _testing_pendingWaiterCount() -> Int {
        stateQueue.sync { responseWaiters.count }
    }

    static func overlayOrigin(for urlString: String) -> String? {
        // Gate on http/https only. `URL` happily parses `app://something/foo`
        // with scheme="app" and host="something", which would key
        // `Fetch.enable` patterns on a non-http origin that CDP cannot
        // intercept. Match node-server (`resolveFetchProxyOrigin`) by falling
        // back to the overlay iframe's `http://localhost:<servePort>` origin
        // for any non-http parent — file://, app://, etc.
        guard let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host else {
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
