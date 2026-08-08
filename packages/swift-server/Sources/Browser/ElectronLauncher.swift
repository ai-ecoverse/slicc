import AppKit
import Foundation
import Logging

private let electronOverlaySyncIntervalNanoseconds: UInt64 = 1_500_000_000

/// Cadence of the per-session overlay presence re-check. Covers SPAs that
/// re-render their DOM root (evicting `#slicc-electron-overlay-root`) without
/// emitting any navigation event for the event-driven re-injection to hook.
/// Mirrors `ELECTRON_OVERLAY_PRESENCE_CHECK_INTERVAL_MS` in node-server's
/// `electron-controller.ts`.
// Internal (not private) so `OverlayTargetSession` in its own file can read it.
let electronOverlayPresenceCheckIntervalNanoseconds: UInt64 = 2_000_000_000

/// First-attempt overlay probe cadence + budget. A single-shot probe could
/// fire while the overlay iframe was still at `about:blank` — before its
/// cross-origin navigation committed — yielding a false "blocked" that tripped
/// a needless CSP-bypass reload. On swift that reload then connected the `/cdp`
/// bridge client, starving the injector's own CDP session and looping forever.
/// Polling catches the cross-origin commit the instant it happens so a
/// CSP-bearing app (AEM, Slack) renders on Phase-1 and escalation only fires
/// when the frame genuinely never commits.
// Internal (not private) so `OverlayTargetSession` in its own file can read them.
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
            !data.isEmpty
        {
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
    // MUST match SLICC_HOSTED_ORIGIN in packages/shared-ts/src/bridge-protocol.ts
    return "https://www.sliccy.ai"
}

/// Pre-built thin-mode bootstrap pair — one per overlay role. The
/// injector picks `leader` for the first injected target and `follower`
/// for every subsequent target. Mirrors `ThinBootstrapSet` in
/// `packages/node-server/src/electron-controller.ts`.
struct ThinBootstrapSet: Sendable {
    let leader: String
    let follower: String
    /// Status-only overlay bootstrap (launcher + message, no iframe) for
    /// egress-blocked apps. See `buildElectronOverlayStatusBootstrapScript`.
    let status: String
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

// Egress-block detection helpers (`overlayEgressBlockErrorTexts`,
// `OverlayNetworkSignal`, `isEgressBlockError`, `classifyNetworkEvent`) live in
// `ElectronOverlayEgress.swift`.

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
    /// Per-process bridge token, present in every overlay app URL. Used to
    /// correlate a `Network.loadingFailed` back to OUR overlay iframe's document
    /// request (vs the app's own frames) when detecting an egress block.
    private let bridgeToken: String
    private let stateQueue = DispatchQueue(label: "slicc.browser.electron-overlay-injector")
    private var sessions: [String: OverlayTargetSession] = [:]
    private var cspBypassedURLs = Set<String>()
    /// Targets whose overlay iframe was denied at the network layer by the app
    /// itself (e.g. Signal → `net::ERR_ACCESS_DENIED`). The reload/Fetch-proxy
    /// escalation cannot rescue these, so once a target is here we stop
    /// escalating and never record it as CSP-bypassed. Mirrors node-server's
    /// `egressBlockedTargets`.
    private var egressBlockedURLs = Set<String>()
    private var pollTask: Task<Void, Never>?
    /// URL of the target currently elected as the pinned leader. Cleared
    /// by `syncTargets` when that target disappears so the next injection
    /// re-elects a fresh leader. Mirrors node-server's `leaderTargetUrl`
    /// in `electron-controller.ts`.
    private var leaderTargetURL: String?

    /// Fired exactly once, the first time any target is detected to deny the
    /// overlay's network egress (e.g. Signal). `ServerCommand` sets this to start
    /// the headless CDP-over-CDP tray follower, mirroring node-server's
    /// `onEgressBlocked` hook wired from `index.ts`. The argument is the blocked
    /// target's URL.
    var onEgressBlocked: (@Sendable (String) -> Void)?

    /// Test-only injection seam: when set, `loadBootstrapScripts()` returns
    /// this pair instead of reading bundle files. Mirrors node-server's
    /// `_createForTesting` bootstrap override so unit tests can drive the
    /// per-target connect flow without bundle I/O.
    private let testingThinBootstraps: ThinBootstrapSet?

    init(
        cdpPort: Int,
        servePort: Int,
        projectRoot: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        session: URLSession = .shared,
        logger: Logger = Logger(label: "slicc.browser.electron-overlay"),
        probeDelayNanoseconds: UInt64 = 1_500_000_000,
        thinBridge: ThinBridgeConfig
    ) {
        self.cdpPort = cdpPort
        self.servePort = servePort
        self.projectRoot = projectRoot
        self.session = session
        self.logger = logger
        self.probeDelayNanoseconds = probeDelayNanoseconds
        self.thinBridge = thinBridge
        self.bridgeToken = thinBridge.bridgeToken
        self.testingThinBootstraps = nil
    }

    /// Test-only init that skips bundle loading and lets tests drive the
    /// per-target connect flow directly with controllable bootstrap
    /// markers + probe delay. Mirrors node-server's
    /// `ElectronOverlayInjector._createForTesting` factory.
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
            let step =
                intervalNanoseconds == 0
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
            let session = makeTargetSession(
                target: target, bootstrapScript: bootstrap, statusBootstrapScript: bootstraps.status)
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

    /// Snapshot of URLs marked egress-blocked in this injector's lifetime.
    /// Mirrors node-server's `_testingEgressBlockedTargets()`.
    func _testing_egressBlockedURLs() -> Set<String> {
        stateQueue.sync { egressBlockedURLs }
    }

    /// Seed egress-blocked state for tests. Mirrors node-server's
    /// `_testingSeedEgressBlockedTarget`.
    func _testing_seedEgressBlockedURL(_ url: String) {
        stateQueue.sync { _ = egressBlockedURLs.insert(url) }
    }

    /// Record a target as egress-blocked and fire `onEgressBlocked` the FIRST
    /// time any target blocks egress (so the tray follower is started once per
    /// attach, not once per target). Mirrors node-server's one-shot
    /// `onEgressBlocked` dispatch in `electron-controller.ts`.
    func markEgressBlockedAndNotify(_ url: String) {
        let shouldNotify: Bool = stateQueue.sync {
            let wasEmpty = egressBlockedURLs.isEmpty
            egressBlockedURLs.insert(url)
            return wasEmpty
        }
        if shouldNotify { onEgressBlocked?(url) }
    }

    /// Build the thin-bridge bootstrap pair loaded once per `syncTargets`
    /// cycle: leader/follower variants whose only difference is the `role=`
    /// query param on the hosted launcher URL. This is the only overlay
    /// path — the legacy bundled-overlay bootstrap was retired. Throws when
    /// no thin-bridge config is available (fail fast rather than serving a
    /// now-removed bundled overlay).
    func loadBootstrapScripts() throws -> ThinBootstrapSet {
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

        let bundleSource = try loadOverlayBundleSource()
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
