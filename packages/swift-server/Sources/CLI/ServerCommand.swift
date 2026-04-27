import ArgumentParser
import AsyncHTTPClient
import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import ServiceLifecycle

@main
@available(macOS 10.15, *)
struct ServerCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "slicc-server",
        abstract: "Run the native SLICC standalone server."
    )

    @Flag(name: .long, help: "Enable dev mode")
    var dev: Bool = false

    @Flag(name: .long, help: "Serve-only mode (reuse external CDP)")
    var serveOnly: Bool = false

    @Option(name: .long, help: "CDP port")
    var cdpPort: Int = ServerConfig.defaultCliCdpPort

    @Flag(name: .long, help: "Electron mode")
    var electron: Bool = false

    @Option(name: .long, help: "Electron app path")
    var electronApp: String?

    @Flag(name: .long, help: "Kill existing Electron app")
    var kill: Bool = false

    @Flag(name: .long, help: "Lead mode")
    var lead: Bool = false

    @Option(name: .long, help: "Lead worker base URL")
    var leadWorkerBaseUrl: String?

    @Option(name: .long, help: "Chrome profile name")
    var profile: String?

    @Flag(name: .long, help: "Join mode")
    var join: Bool = false

    @Option(name: .long, help: "Join URL")
    var joinUrl: String?

    @Option(name: .long, help: "Log level")
    var logLevel: String = "info"

    @Option(name: .long, help: "Log directory")
    var logDir: String?

    @Option(name: .long, help: "Auto-submit prompt")
    var prompt: String?

    @Option(name: .long, help: "Browser engine (chrome or webkit)")
    var browser: String = "chrome"

    @Option(name: .long, help: "Path to static UI files (dist/ui)")
    var staticRoot: String?

    @Option(name: .long, help: "Path to secrets .env file")
    var envFile: String?

    mutating func run() async throws {
        let config = ServerConfig.resolve(from: self)
        let logLevel = Self.loggerLevel(from: config.logLevel)
        let logDirectory = config.logDirectoryURL ?? FileLogger.defaultLogDirectory
        let fileLoggerConfiguration = FileLoggerConfiguration(
            logDirectory: logDirectory,
            logLevel: logLevel
        )

        SliccLogging.bootstrap(logLevel: logLevel, logDirectory: logDirectory)

        let logger = Logger(label: "slicc.server")
        let fileLogger = FileLogger(label: "slicc.server", configuration: fileLoggerConfiguration)
        let currentDirectoryPath = FileManager.default.currentDirectoryPath
        let repositoryRoot = Self.repositoryRoot(currentDirectoryPath: currentDirectoryPath)
        let environment = ProcessInfo.processInfo.environment

        let servePort = try await Self.resolveServePort(from: environment)
        var cdpPort = config.serveOnly
            ? config.cdpPort
            : try await findAvailablePort(startingFrom: config.cdpPort)

        let serveOrigin = "http://localhost:\(servePort)"

        var browserProcess: Process?
        var browserLabel = config.electron ? "Electron" : (config.webkitMode ? "WebKit" : "Chrome")
        var overlayInjector: ElectronOverlayInjector?
        var webkitProcess: WebKitProcess?

        // Read the Keychain before launching the browser so the macOS ACL
        // prompt appears in front of the still-focused terminal instead of
        // stacking behind the new Chrome/Electron window. Post-#493 there
        // is at most one prompt (single `__envfile__` blob), but it still
        // pops on the first slicc-server run after Sliccstart wrote the
        // blob, and SecretStore.all() is what triggers it.
        let envFileSecrets: [Secret] = config.envFileURL.flatMap { Self.parseEnvFileSecrets(at: $0) } ?? []
        let secretInjector = SecretInjector(sessionId: UUID().uuidString, envFileSecrets: envFileSecrets)

        if config.webkitMode, !config.serveOnly {
            let webkitLauncher = WebKitLauncher(logger: Logger(label: "slicc.webkit-launcher"))
            guard let webkitPath = webkitLauncher.findWebKitExecutable() else {
                throw ValidationError(
                    "Could not find WebKit binary. Set WEBKIT_PATH or install Playwright WebKit: npx playwright install webkit"
                )
            }
            logger.info("Found WebKit: \(webkitPath)")

            let frameworkPath = environment["DYLD_FRAMEWORK_PATH"]
                ?? webkitLauncher.resolveFrameworkPath(binaryPath: webkitPath)
            let launched = try webkitLauncher.launch(binaryPath: webkitPath, frameworkPath: frameworkPath)
            webkitProcess = launched
            browserLabel = "WebKit"
            print("WebKit launched with inspector pipe")
        } else if config.electron, !config.serveOnly {
            guard let electronApp = config.electronApp else {
                throw ValidationError(
                    "Electron mode requires an app path. Pass --electron <path> or --electron-app=<path>."
                )
            }

            let electronLauncher = ElectronLauncher(logger: Logger(label: "slicc.browser.electron-launcher"))
            let launchedElectron = try await electronLauncher.launch(
                appPath: electronApp,
                cdpPort: cdpPort,
                kill: config.kill
            )
            browserProcess = launchedElectron.process
            browserLabel = launchedElectron.displayName
            cdpPort = launchedElectron.cdpPort
        } else if !config.serveOnly {
            let chromeLauncher = ChromeLauncher(logger: Logger(label: "slicc.chrome-launcher"))
            let chromeExecutable = chromeLauncher.findChromeExecutable()
            let launchURL = try Self.resolveBrowserLaunchURL(
                serveOrigin: serveOrigin,
                config: config,
                environment: environment
            )
            let userDataDir = chromeLauncher.resolveUserDataDir(
                tmpDir: environment["TMPDIR"],
                servePort: servePort
            )

            let launchedChrome = try await chromeLauncher.launch(
                config: ChromeLaunchConfig(
                    projectRoot: repositoryRoot.path,
                    cdpPort: cdpPort,
                    launchUrl: launchURL,
                    userDataDir: userDataDir,
                    executablePath: chromeExecutable,
                    currentDirectoryPath: currentDirectoryPath
                )
            )
            browserProcess = launchedChrome.process
            browserLabel = "Chrome"
            cdpPort = launchedChrome.cdpPort
        }

        let lickSystem = LickSystem()
        let cdpProxy = CDPProxy(logger: Logger(label: "slicc.cdp-proxy"))
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        let startupLatch = ServerStartupLatch()
        let staticRoot = Self.resolveStaticRoot(explicitStaticRoot: config.staticRoot, repositoryRoot: repositoryRoot)

        let router = Router(context: BasicRequestContext.self)
        router.middlewares.add(RequestLogger<BasicRequestContext>(logger: Logger(label: "slicc.request")))
        router.middlewares.add(
            StaticFileMiddleware<BasicRequestContext>(
                staticRoot: staticRoot,
                logger: Logger(label: "slicc.static-files")
            )
        )
        registerAPIRoutes(router: router, lickSystem: lickSystem, config: config, httpClient: httpClient, secretInjector: secretInjector)

        // Install WebKit pipe bridge on the CDP proxy before setting up routes
        if let webkitProcess {
            await cdpProxy.installPipeMode(pipeWrite: webkitProcess.pipeWrite, pipeRead: webkitProcess.pipeRead)
        }

        let wsRouter = Router(context: BasicWebSocketRequestContext.self)
        await cdpProxy.install(on: wsRouter, cdpPort: cdpPort)
        LickWebSocketRoute.register(on: wsRouter, lickSystem: lickSystem)

        let app = Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: wsRouter,
                // Hummingbird's WebSocket frame size is configured at the server-builder level,
                // not per route. `/cdp` needs large frames for Chrome payloads, while `/licks-ws`
                // only carries small local JSON messages, so keeping the higher localhost-only
                // limit here is wasteful but not a security concern.
                configuration: .init(maxFrameSize: CDPProxy.defaultMaxMessageSize)
            ),
            configuration: .init(
                address: .hostname("127.0.0.1", port: servePort),
                serverName: "slicc-server"
            ),
            onServerRunning: { _ in
                await startupLatch.signalStarted()
            },
            logger: logger
        )

        let serviceGroup = ServiceGroup(services: [app], logger: logger)
        let serverController = ServiceGroupServerController(serviceGroup: serviceGroup)
        let shutdownHandler = GracefulShutdownHandler()

        let appTask = Task {
            try await serviceGroup.run()
        }

        do {
            // Race the startup latch against appTask failure. If the server
            // fails before onServerRunning fires (e.g. bind error), we need
            // to surface that instead of hanging on the latch forever.
            // A separate Task watches appTask and signals the latch on failure.
            let startupFailure = StartupFailureBox()
            let errorObserver = Task { [startupLatch] in
                do {
                    try await appTask.value
                } catch {
                    await startupFailure.set(error)
                    await startupLatch.signalStarted()
                }
            }
            await startupLatch.waitUntilStarted()
            errorObserver.cancel()
            if let error = await startupFailure.get() {
                throw error
            }

            do {
                try await cdpProxy.preWarm(cdpPort: cdpPort)
            } catch {
                logger.warning("CDP proxy pre-warm failed", metadata: ["error": .string(error.localizedDescription)])
            }

            let consoleForwarder: ConsoleForwarder?
            if config.webkitMode {
                // WebKit mode: no console forwarder or overlay needed
                consoleForwarder = nil
            } else if config.electron {
                let injector = ElectronOverlayInjector(
                    cdpPort: cdpPort,
                    servePort: servePort,
                    projectRoot: repositoryRoot,
                    logger: Logger(label: "slicc.browser.electron-overlay")
                )
                injector.start()
                overlayInjector = injector
                consoleForwarder = nil
            } else {
                let forwarder = ConsoleForwarder(logger: Logger(label: "slicc.browser.console-forwarder"))
                await forwarder.start(cdpPort: cdpPort, pageUrl: String(servePort))
                consoleForwarder = forwarder
            }

            await shutdownHandler.install(
                context: ShutdownContext(
                    browserProcess: browserProcess,
                    webkitProcess: webkitProcess,
                    browserLabel: browserLabel,
                    cdpPort: cdpPort,
                    fileLogger: fileLogger,
                    overlayInjector: overlayInjector,
                    cdpProxy: cdpProxy,
                    clientSockets: lickSystem,
                    server: serverController
                )
            )

            print("Serving UI at \(serveOrigin)")
            if config.webkitMode {
                print("WebKit pipe proxy at ws://localhost:\(servePort)/cdp")
            } else {
                print("CDP proxy at ws://localhost:\(servePort)/cdp")
            }

            try await appTask.value
            await consoleForwarder?.stop()
            overlayInjector?.stop()
            try await httpClient.shutdown()
        } catch {
            appTask.cancel()
            overlayInjector?.stop()
            try? await httpClient.shutdown()
            throw error
        }
    }
}

struct ServerConfig: Sendable, Equatable {
    static let defaultCliCdpPort = 9222
    static let defaultElectronAttachCdpPort = 9223
    static let validLogLevels: Set<String> = ["debug", "info", "warn", "error"]

    let dev: Bool
    let serveOnly: Bool
    let cdpPort: Int
    let explicitCdpPort: Bool
    let electron: Bool
    let electronApp: String?
    let electronAppURL: URL?
    let kill: Bool
    let lead: Bool
    let leadWorkerBaseUrl: String?
    let leadWorkerBaseURL: URL?
    let profile: String?
    let join: Bool
    let joinUrl: String?
    let joinURL: URL?
    let logLevel: String
    let logDir: String?
    let logDirectoryURL: URL?
    let prompt: String?
    let browser: String
    let staticRoot: String?
    let envFile: String?
    let envFileURL: URL?

    var webkitMode: Bool { browser == "webkit" }

    static func resolve(from command: ServerCommand) -> ServerConfig {
        resolve(from: command, arguments: ProcessInfo.processInfo.arguments)
    }

    static func resolve(from command: ServerCommand, arguments: [String]) -> ServerConfig {
        let explicitCdpPort = arguments.dropFirst().contains {
            $0 == "--cdp-port" || $0.hasPrefix("--cdp-port=")
        }

        let normalizedElectronApp = normalizedText(command.electronApp)
        let normalizedLeadWorkerBaseUrl = normalizedText(command.leadWorkerBaseUrl)
        let normalizedProfile = normalizedText(command.profile)
        let normalizedJoinUrl = normalizedText(command.joinUrl)
        let normalizedLogDir = normalizedText(command.logDir)
        let normalizedPrompt = normalizedText(command.prompt)
        let normalizedBrowser = command.browser.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedStaticRoot = normalizedText(command.staticRoot)
        let normalizedEnvFile = normalizedText(command.envFile)

        let positiveCdpPort = command.cdpPort > 0 ? command.cdpPort : defaultCliCdpPort
        let resolvedElectron = command.electron || normalizedElectronApp != nil
        let resolvedLead = command.lead || normalizedLeadWorkerBaseUrl != nil
        let resolvedJoin = command.join || normalizedJoinUrl != nil
        let resolvedCdpPort = resolvedElectron && !explicitCdpPort
            ? defaultElectronAttachCdpPort
            : positiveCdpPort

        return ServerConfig(
            dev: command.dev,
            serveOnly: command.serveOnly,
            cdpPort: resolvedCdpPort,
            explicitCdpPort: explicitCdpPort && command.cdpPort > 0,
            electron: resolvedElectron,
            electronApp: normalizedElectronApp,
            electronAppURL: resolvedFileURL(from: normalizedElectronApp),
            kill: command.kill,
            lead: resolvedLead,
            leadWorkerBaseUrl: normalizedLeadWorkerBaseUrl,
            leadWorkerBaseURL: resolvedURL(from: normalizedLeadWorkerBaseUrl),
            profile: normalizedProfile,
            join: resolvedJoin,
            joinUrl: normalizedJoinUrl,
            joinURL: resolvedURL(from: normalizedJoinUrl),
            logLevel: normalizedLogLevel(command.logLevel),
            logDir: normalizedLogDir,
            logDirectoryURL: resolvedFileURL(from: normalizedLogDir),
            prompt: normalizedPrompt,
            browser: normalizedBrowser,
            staticRoot: normalizedStaticRoot,
            envFile: normalizedEnvFile,
            envFileURL: resolvedFileURL(from: normalizedEnvFile)
        )
    }

    private static func normalizedText(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func normalizedLogLevel(_ value: String) -> String {
        let normalizedValue = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return validLogLevels.contains(normalizedValue) ? normalizedValue : "info"
    }

    private static func resolvedURL(from value: String?) -> URL? {
        guard let value else {
            return nil
        }
        return URL(string: value)
    }

    private static func resolvedFileURL(from value: String?) -> URL? {
        guard let value else {
            return nil
        }

        let expandedPath = NSString(string: value).expandingTildeInPath
        return URL(fileURLWithPath: expandedPath).standardizedFileURL
    }
}

@available(macOS 14, *)
private actor StartupFailureBox {
    private var error: Error?
    func set(_ error: Error) { self.error = error }
    func get() -> Error? { error }
}

@available(macOS 14, *)
private actor ServerStartupLatch {
    private var started = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func signalStarted() {
        guard !started else { return }
        started = true
        let continuations = self.continuations
        self.continuations.removeAll()
        for continuation in continuations {
            continuation.resume()
        }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { continuation in
            self.continuations.append(continuation)
        }
    }
}

@available(macOS 14, *)
private actor ServiceGroupServerController: GracefulShutdownServer {
    private let serviceGroup: ServiceGroup

    init(serviceGroup: ServiceGroup) {
        self.serviceGroup = serviceGroup
    }

    func stop() async {
        await serviceGroup.triggerGracefulShutdown()
    }
}

extension ServerCommand {
    static let defaultServePort = 5710

    static func loggerLevel(from value: String) -> Logger.Level {
        switch value {
        case "debug":
            .debug
        case "warn":
            .warning
        case "error":
            .error
        default:
            .info
        }
    }

    static func resolveServePort(
        from environment: [String: String],
        resolveAvailablePort: (Int, Bool) async throws -> Int = { preferred, strict in
            try await findAvailablePort(startingFrom: preferred, strict: strict)
        }
    ) async throws -> Int {
        // If the launcher or operator explicitly set PORT=..., respect it
        // strictly — silently binding a neighbouring port would break the
        // contract with whoever told us which port to use and leave Chrome
        // pointed at a dead origin. When PORT is not set, fall back to the
        // permissive walking behaviour so `slicc-server` still starts on a
        // free neighbour if 5710 is casually in use.
        if let explicit = preferredServePort(from: environment) {
            return try await resolveAvailablePort(explicit, true)
        }
        return try await resolveAvailablePort(defaultServePort, false)
    }

    static func preferredServePort(from environment: [String: String]) -> Int? {
        guard let rawPort = environment["PORT"],
              let port = Int(rawPort.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1...65_535).contains(port) else {
            return nil
        }
        return port
    }

    static func repositoryRoot(
        bundlePath: String = Bundle.main.bundlePath,
        resourcePath: String? = Bundle.main.resourcePath,
        currentDirectoryPath: String = FileManager.default.currentDirectoryPath,
        fileManager: FileManager = .default,
        filePath: String = #filePath
    ) -> URL {
        if bundlePath.hasSuffix(".app"), let resourcePath {
            return URL(fileURLWithPath: resourcePath, isDirectory: true)
                .appendingPathComponent("slicc", isDirectory: true)
        }

        let cwdRoot = URL(fileURLWithPath: currentDirectoryPath, isDirectory: true)
        let cwdStaticRoot = cwdRoot.appendingPathComponent("dist/ui", isDirectory: true).path
        if fileManager.fileExists(atPath: cwdStaticRoot) {
            return cwdRoot
        }

        // filePath = packages/swift-server/Sources/CLI/ServerCommand.swift
        // Need 5 levels up to reach the repo root.
        return URL(fileURLWithPath: filePath)
            .deletingLastPathComponent()  // CLI/
            .deletingLastPathComponent()  // Sources/
            .deletingLastPathComponent()  // swift-server/
            .deletingLastPathComponent()  // packages/
            .deletingLastPathComponent()  // repo root
    }

    static func resolveStaticRoot(
        explicitStaticRoot: String?,
        repositoryRoot: URL,
        bundlePath: String = Bundle.main.bundlePath,
        resourcePath: String? = Bundle.main.resourcePath
    ) -> String {
        if let explicitStaticRoot {
            return explicitStaticRoot
        }

        if bundlePath.hasSuffix(".app"), let resourcePath {
            return resourcePath + "/slicc/dist/ui"
        }

        return repositoryRoot.appendingPathComponent("dist/ui", isDirectory: true).path
    }

    static func resolveBrowserLaunchURL(
        serveOrigin: String,
        config: ServerConfig,
        environment: [String: String]
    ) throws -> String {
        if config.lead && config.join {
            throw ValidationError("The --lead and --join launch flows are mutually exclusive.")
        }

        var launchURL = serveOrigin
        if config.join {
            guard let joinURL = config.joinUrl else {
                throw ValidationError(
                    "The --join launch flow requires a tray join URL via --join <url> or --join=<url>."
                )
            }
            launchURL = try buildTrayJoinLaunchURL(locationHref: serveOrigin, joinURL: joinURL)
        } else if config.lead {
            guard let workerBaseURL = normalizeTrayWorkerBaseURL(
                config.leadWorkerBaseUrl ?? environment["WORKER_BASE_URL"]
            ) else {
                throw ValidationError(
                    "The --lead launch flow requires a tray worker base URL via --lead <url>, --lead=<url>, or WORKER_BASE_URL."
                )
            }
            launchURL = try buildCanonicalTrayLaunchURL(locationHref: serveOrigin, trayValue: workerBaseURL)
        }

        guard let prompt = config.prompt else {
            return launchURL
        }
        return try appendQueryItem(urlString: launchURL, name: "prompt", value: prompt)
    }

    static func buildTrayJoinLaunchURL(locationHref: String, joinURL: String) throws -> String {
        guard let parsedJoinURL = parseTrayJoinURL(joinURL) else {
            throw ValidationError("Invalid tray join URL: \(joinURL)")
        }
        return try buildCanonicalTrayLaunchURL(locationHref: locationHref, trayValue: parsedJoinURL.joinURL)
    }

    static func parseTrayJoinURL(_ raw: String?) -> ParsedTrayJoinURL? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              var components = URLComponents(string: raw) else {
            return nil
        }

        components.query = nil
        components.fragment = nil

        let normalizedJoinURL = components.string ?? raw
        let segments = components.path.split(separator: "/").map(String.init)
        guard segments.count >= 2, segments[segments.count - 2] == "join" else {
            return nil
        }

        let token = segments.last?.removingPercentEncoding ?? segments.last ?? ""
        let tokenParts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard tokenParts.count == 2,
              !tokenParts[0].isEmpty,
              !tokenParts[1].isEmpty else {
            return nil
        }

        return ParsedTrayJoinURL(joinURL: normalizedJoinURL)
    }

    static func normalizeTrayWorkerBaseURL(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              var components = URLComponents(string: raw),
              components.scheme != nil,
              components.host != nil else {
            return nil
        }

        components.query = nil
        components.fragment = nil

        if components.path != "/" {
            let trimmedPath = components.path.replacingOccurrences(
                of: #"/+$"#,
                with: "",
                options: .regularExpression
            )
            components.path = trimmedPath.isEmpty ? "/" : trimmedPath
        }

        guard var normalized = components.string else {
            return nil
        }
        if normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        return normalized
    }

    static func buildCanonicalTrayLaunchURL(locationHref: String, trayValue: String) throws -> String {
        guard var components = URLComponents(string: locationHref) else {
            throw ValidationError("Invalid launch URL: \(locationHref)")
        }

        var queryItems = components.queryItems ?? []
        queryItems.removeAll {
            $0.name == "trayWorkerUrl" || $0.name == "lead" || $0.name == "tray"
        }
        queryItems.append(URLQueryItem(name: "tray", value: trayValue))
        components.queryItems = queryItems.isEmpty ? nil : queryItems

        guard let url = components.url else {
            throw ValidationError("Invalid launch URL: \(locationHref)")
        }
        return url.absoluteString
    }

    static func appendQueryItem(urlString: String, name: String, value: String) throws -> String {
        guard var components = URLComponents(string: urlString) else {
            throw ValidationError("Invalid launch URL: \(urlString)")
        }

        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: name, value: value))
        components.queryItems = queryItems

        guard let url = components.url else {
            throw ValidationError("Invalid launch URL: \(urlString)")
        }
        return url.absoluteString
    }

    struct ParsedTrayJoinURL {
        let joinURL: String
    }

    /// Parse a .env file into `[Secret]` entries.
    ///
    /// Expects KEY=VALUE lines and KEY_DOMAINS=domain1,domain2 lines.
    /// Keys without a matching _DOMAINS entry are skipped. Shares its parser
    /// with `SecretStore`'s Keychain blob, so a `--env-file` override and the
    /// stored blob accept exactly the same syntax.
    static func parseEnvFileSecrets(at url: URL) -> [Secret]? {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return EnvFileFormat.secretsFromBlob(content)
    }
}