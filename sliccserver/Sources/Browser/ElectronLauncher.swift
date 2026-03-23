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
            try? await Task.sleep(nanoseconds: 100_000_000)
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

final class ElectronOverlayInjector: @unchecked Sendable {
    private let cdpPort: Int
    private let servePort: Int
    private let projectRoot: URL
    private let session: URLSession
    private let logger: Logger
    private let stateQueue = DispatchQueue(label: "slicc.browser.electron-overlay-injector")
    private var injectedTargets = Set<String>()
    private var inFlightTargets = Set<String>()
    private var pollTask: Task<Void, Never>?

    init(
        cdpPort: Int,
        servePort: Int,
        projectRoot: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        session: URLSession = .shared,
        logger: Logger = Logger(label: "slicc.browser.electron-overlay")
    ) {
        self.cdpPort = cdpPort
        self.servePort = servePort
        self.projectRoot = projectRoot
        self.session = session
        self.logger = logger
    }

    func start() {
        guard stateQueue.sync(execute: { pollTask == nil }) else { return }
        pollTask = Task { [weak self] in
            guard let self else { return }
            await self.runPollingLoop()
        }
    }

    func stop() {
        stateQueue.sync {
            pollTask?.cancel()
            pollTask = nil
            injectedTargets.removeAll()
            inFlightTargets.removeAll()
        }
    }

    private func runPollingLoop() async {
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
        let liveTargetIDs = Set(selectedTargets.compactMap(\.webSocketDebuggerURL))

        stateQueue.sync {
            injectedTargets = injectedTargets.intersection(liveTargetIDs)
            inFlightTargets = inFlightTargets.intersection(liveTargetIDs)
        }

        for target in selectedTargets {
            guard let targetID = target.webSocketDebuggerURL else { continue }
            let shouldInject = stateQueue.sync { () -> Bool in
                guard !injectedTargets.contains(targetID), !inFlightTargets.contains(targetID) else {
                    return false
                }
                inFlightTargets.insert(targetID)
                return true
            }
            guard shouldInject else { continue }

            Task { [weak self] in
                guard let self else { return }
                defer {
                    _ = self.stateQueue.sync {
                        self.inFlightTargets.remove(targetID)
                    }
                }
                do {
                    try await self.injectOverlay(into: target, script: bootstrapScript)
                    _ = self.stateQueue.sync {
                        self.injectedTargets.insert(targetID)
                    }
                } catch {
                    self.logger.error("Electron overlay injection failed", metadata: [
                        "target": .string(target.url),
                        "error": .string(error.localizedDescription)
                    ])
                }
            }
        }
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

    private func injectOverlay(into target: ElectronInspectableTarget, script: String) async throws {
        guard let debuggerURL = target.webSocketDebuggerURL,
              let url = URL(string: debuggerURL) else {
            return
        }

        let socket = session.webSocketTask(with: url)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }

        try await send(message: ["id": 1, "method": "Runtime.enable"], over: socket)
        try await send(message: ["id": 2, "method": "Page.enable"], over: socket)
        try await send(message: [
            "id": 3,
            "method": "Runtime.evaluate",
            "params": [
                "expression": script,
                "awaitPromise": false
            ]
        ], over: socket)
    }

    private func send(message: [String: Any], over socket: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: message)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CocoaError(.coderInvalidValue)
        }
        try await socket.send(.string(text))
    }
}