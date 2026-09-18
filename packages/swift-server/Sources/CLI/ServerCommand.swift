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

    
    
    
    
    
    
    @Flag(name: .long, help: "Lead mode (needs --lead-worker-base-url or WORKER_BASE_URL)")
    var lead: Bool = false

    @Option(name: .long, help: "Tray worker base URL for --lead (or set WORKER_BASE_URL)")
    var leadWorkerBaseUrl: String?

    @Option(name: .long, help: "Chrome profile name")
    var profile: String?

    
    
    
    
    
    @Option(
        name: [.customLong("join"), .customLong("join-url")],
        help: "Tray join URL (accepts --join <url> or --join-url <url>)"
    )
    var joinUrl: String?

    @Option(name: .long, help: "Log level")
    var logLevel: String = "info"

    @Option(name: .long, help: "Log directory")
    var logDir: String?

    @Option(name: .long, help: "Auto-submit prompt")
    var prompt: String?

    @Option(name: .long, help: "Path to secrets .env file")
    var envFile: String?

    
    
    
    
    
    @Option(
        name: .customLong("mount"),
        help:
            "Host folder to auto-mount, as <os-path>:<slicc-path> (repeatable, e.g. --mount ~/proj:/mnt/proj)"
    )
    var mount: [String] = []

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
        var cdpPort =
            config.serveOnly
            ? config.cdpPort
            : try await findAvailablePort(startingFrom: config.cdpPort)

        let serveOrigin = "http://localhost:\(servePort)"

        
        
        
        
        let thinBridgeMode = Self.isThinBridgeMode(config: config)
        
        
        
        
        
        let thinElectronMode = Self.isThinElectronMode(config: config, environment: environment)
        let bridgeToken: String? = Self.resolveBridgeToken(
            thinBridgeMode: thinBridgeMode,
            thinElectronMode: thinElectronMode,
            environment: environment
        )

        var browserProcess: Process?
        
        
        
        
        var browserKillPid: pid_t?
        var browserLabel = config.electron ? "Electron" : "Chrome"
        var overlayInjector: ElectronOverlayInjector?
        
        
        
        
        var electronFollower: ElectronTrayFollower?
        
        
        
        
        var tabSessionRecorder: TabSessionRecorder?

        
        
        
        
        
        
        let envFileSecrets: [Secret] = config.envFileURL.flatMap { Self.parseEnvFileSecrets(at: $0) } ?? []
        
        
        
        
        let sessionDir: URL = {
            if let envFileURL = config.envFileURL {
                return envFileURL.deletingLastPathComponent()
            }
            let home = URL(fileURLWithPath: NSHomeDirectory())
            return home.appendingPathComponent(".slicc")
        }()
        let sessionId: String
        do {
            sessionId = try SecretInjector.readOrCreateSessionId(in: sessionDir)
        } catch {
            
            
            logger.warning(
                "session-id persistence failed; falling back to ephemeral session",
                metadata: ["error": .string(String(describing: error))]
            )
            sessionId = UUID().uuidString
        }
        let oauthStore = OAuthSecretStore()
        let secretInjector = SecretInjector(
            sessionId: sessionId,
            envFileSecrets: envFileSecrets,
            oauthStore: oauthStore
        )
        
        
        
        
        
        
        
        

        if config.electron, !config.serveOnly {
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
                environment: environment,
                bridgeWsUrl: thinBridgeMode ? "ws://localhost:\(servePort)/cdp" : nil,
                bridgeToken: bridgeToken
            )
            let userDataDir = chromeLauncher.resolveUserDataDir(servePort: servePort)
            
            
            
            
            let sliccOrigins = [resolveHostedLeaderOrigin(environment: environment), serveOrigin]
            let tabSessionStore = TabSessionStore(
                fileURL: TabSessionStore.defaultFileURL(userDataDir: userDataDir)
            )
            let restoreUrls = tabSessionStore.load(hostedOrigins: sliccOrigins)
            if !restoreUrls.isEmpty {
                logger.info("Reopening \(restoreUrls.count) tab(s) from the previous session")
            }

            let launchedChrome = try await chromeLauncher.launch(
                config: ChromeLaunchConfig(
                    projectRoot: repositoryRoot.path,
                    cdpPort: cdpPort,
                    launchUrl: launchURL,
                    userDataDir: userDataDir,
                    executablePath: chromeExecutable,
                    currentDirectoryPath: currentDirectoryPath,
                    restoreUrls: restoreUrls
                )
            )
            browserProcess = launchedChrome.process
            browserKillPid = launchedChrome.chromePid
            browserLabel = "Chrome"
            cdpPort = launchedChrome.cdpPort
            tabSessionRecorder = TabSessionRecorder(
                store: tabSessionStore,
                cdpPort: cdpPort,
                hostedOrigins: sliccOrigins
            )
        }

        let lickSystem = LickSystem()
        let agentActivityTracker = AgentActivityTracker()
        let cdpProxy = CDPProxy(
            logger: Logger(label: "slicc.cdp-proxy"),
            secretInjector: secretInjector
        )
        var httpConfiguration = HTTPClient.Configuration()
        
        
        
        
        httpConfiguration.decompression = .enabled(limit: .none)
        let httpClient = HTTPClient(
            eventLoopGroupProvider: .singleton,
            configuration: httpConfiguration
        )
        let startupLatch = ServerStartupLatch()

        let router = Router(context: BasicRequestContext.self)
        router.middlewares.add(RequestLogger<BasicRequestContext>(logger: Logger(label: "slicc.request")))
        if Self.shouldMountThinBridgeCors(thinBridgeMode: thinBridgeMode, bridgeToken: bridgeToken) {
            
            
            
            
            
            
            
            
            
            
            
            
            router.middlewares.add(ThinBridgeCorsMiddleware<BasicRequestContext>(bridgeToken: bridgeToken))
        }
        registerAPIRoutes(
            router: router,
            lickSystem: lickSystem,
            config: config,
            httpClient: httpClient,
            agentActivityTracker: agentActivityTracker,
            secretInjector: secretInjector,
            oauthStore: oauthStore
        )

        let wsRouter = Router(context: BasicWebSocketRequestContext.self)
        await cdpProxy.install(on: wsRouter, cdpPort: cdpPort, bridgeToken: bridgeToken)
        LickWebSocketRoute.register(on: wsRouter, lickSystem: lickSystem)

        let app = Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: wsRouter,
                
                
                
                
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
            if config.electron {
                
                
                
                
                
                
                if let bridgeToken {
                    let thinBridge = ThinBridgeConfig(
                        hostedLeaderOrigin: resolveHostedLeaderOrigin(environment: environment),
                        bridgeWsUrl: "ws://localhost:\(servePort)/cdp",
                        bridgeToken: bridgeToken
                    )
                    let injector = ElectronOverlayInjector(
                        cdpPort: cdpPort,
                        servePort: servePort,
                        projectRoot: repositoryRoot,
                        logger: Logger(label: "slicc.browser.electron-overlay"),
                        thinBridge: thinBridge,
                        
                        
                        
                        
                        
                        
                        
                        
                        
                        trayJoinUrl: config.joinUrl.flatMap { Self.parseTrayJoinURL($0)?.joinURL }
                    )
                    
                    
                    
                    
                    
                    if let joinURLString = config.joinUrl,
                        let joinURL = URL(string: joinURLString)
                    {
                        let follower = ElectronTrayFollower(
                            cdpPort: cdpPort,
                            joinURL: joinURL,
                            logger: Logger(label: "slicc.browser.electron-follower")
                        )
                        injector.onEgressBlocked = { [weak follower] _ in
                            follower?.startIfNeeded()
                        }
                        electronFollower = follower
                    }
                    injector.start()
                    overlayInjector = injector
                } else {
                    let message =
                        "Cannot start Electron overlay injector: no bridge token resolved. "
                        + "The thin-bridge overlay requires a per-process bridge token "
                        + "(set SLICC_HOSTED_LEADER_ORIGIN to enable thin-electron mode)."
                    logger.error("\(message)")
                }
                consoleForwarder = nil
            } else {
                let forwarder = ConsoleForwarder(logger: Logger(label: "slicc.browser.console-forwarder"))
                await forwarder.start(cdpPort: cdpPort, pageUrl: String(servePort))
                consoleForwarder = forwarder
            }

            await shutdownHandler.install(
                context: ShutdownContext(
                    browserProcess: browserProcess,
                    browserKillPid: browserKillPid,
                    browserLabel: browserLabel,
                    cdpPort: cdpPort,
                    fileLogger: fileLogger,
                    overlayInjector: overlayInjector,
                    cdpProxy: cdpProxy,
                    clientSockets: lickSystem,
                    server: serverController,
                    tabRecorder: tabSessionRecorder
                )
            )

            await tabSessionRecorder?.start()

            if thinBridgeMode {
                print("Thin /cdp bridge + /api at \(serveOrigin)")
            } else if thinElectronMode {
                print("Thin Electron overlay + /cdp gate at \(serveOrigin)")
            } else {
                print("Serving UI at \(serveOrigin)")
            }
            print("CDP proxy at ws://localhost:\(servePort)/cdp")

            try await appTask.value
            await consoleForwarder?.stop()
            await tabSessionRecorder?.stop()
            electronFollower?.stop()
            overlayInjector?.stop()
            try await httpClient.shutdown()
        } catch {
            appTask.cancel()
            await tabSessionRecorder?.stop()
            electronFollower?.stop()
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
    let envFile: String?
    let envFileURL: URL?
    
    struct MountMapping: Sendable, Equatable {
        let hostPath: String
        let path: String
    }

    
    var mounts: [MountMapping] = []

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
        let normalizedEnvFile = normalizedText(command.envFile)

        let positiveCdpPort = command.cdpPort > 0 ? command.cdpPort : defaultCliCdpPort
        let resolvedElectron = command.electron || normalizedElectronApp != nil
        let resolvedLead = command.lead || normalizedLeadWorkerBaseUrl != nil
        let resolvedJoin = normalizedJoinUrl != nil
        let resolvedCdpPort =
            resolvedElectron && !explicitCdpPort
            ? defaultElectronAttachCdpPort
            : positiveCdpPort

        return ServerConfig(
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
            envFile: normalizedEnvFile,
            envFileURL: resolvedFileURL(from: normalizedEnvFile),
            mounts: normalizedMountTable(command.mount)
        )
    }

    
    
    
    
    
    private static func normalizedAbsolutePath(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }
        var path = trimmed
        while path.count > 1, path.hasSuffix("/") {
            path.removeLast()
        }
        guard !path.isEmpty else { return nil }
        if path != "/" {
            let segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
            guard segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
                return nil
            }
        }
        return path
    }

    
    
    
    
    static func parseMountMapping(
        _ value: String,
        homeDirectory: String = NSHomeDirectory()
    ) -> MountMapping? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let sep = trimmed.lastIndex(of: ":"), sep != trimmed.startIndex else { return nil }
        var hostRaw = String(trimmed[trimmed.startIndex..<sep])
            .trimmingCharacters(in: .whitespaces)
        let targetRaw = String(trimmed[trimmed.index(after: sep)...])
            .trimmingCharacters(in: .whitespaces)
        if hostRaw == "~" || hostRaw.hasPrefix("~/") {
            guard !homeDirectory.isEmpty else { return nil }
            hostRaw = homeDirectory + hostRaw.dropFirst()
        }
        guard let hostPath = normalizedAbsolutePath(hostRaw),
            let path = normalizedAbsolutePath(targetRaw),
            path != "/"
        else { return nil }
        return MountMapping(hostPath: hostPath, path: path)
    }

    
    static func normalizedMountTable(_ values: [String]) -> [MountMapping] {
        var seen = Set<String>()
        var result: [MountMapping] = []
        for raw in values {
            guard let mapping = parseMountMapping(raw) else { continue }
            guard seen.insert(mapping.path).inserted else { continue }
            result.append(mapping)
        }
        return result
    }

    private static func normalizedText(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty
        else {
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
actor StartupFailureBox {
    private var error: Error?
    func set(_ error: Error) { self.error = error }
    func get() -> Error? { error }
}

@available(macOS 14, *)
actor ServerStartupLatch {
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
        
        
        
        
        
        
        if let explicit = preferredServePort(from: environment) {
            return try await resolveAvailablePort(explicit, true)
        }
        return try await resolveAvailablePort(defaultServePort, false)
    }

    static func preferredServePort(from environment: [String: String]) -> Int? {
        guard let rawPort = environment["PORT"],
            let port = Int(rawPort.trimmingCharacters(in: .whitespacesAndNewlines)),
            (1...65_535).contains(port)
        else {
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

        
        
        return URL(fileURLWithPath: filePath)
            .deletingLastPathComponent()  
            .deletingLastPathComponent()  
            .deletingLastPathComponent()  
            .deletingLastPathComponent()  
            .deletingLastPathComponent()  
    }

    
    
    
    
    static func isThinBridgeMode(config: ServerConfig) -> Bool {
        !config.serveOnly && !config.electron
    }

    
    
    
    
    
    static func isThinElectronMode(config: ServerConfig, environment: [String: String]) -> Bool {
        guard config.electron, !config.serveOnly else { return false }
        guard let origin = environment["SLICC_HOSTED_LEADER_ORIGIN"], !origin.isEmpty else {
            return false
        }
        return true
    }

    
    
    
    
    
    
    
    
    static func resolveBridgeToken(
        thinBridgeMode: Bool,
        thinElectronMode: Bool,
        environment: [String: String]
    ) -> String? {
        if let token = environment["SLICC_BRIDGE_TOKEN"], !token.isEmpty {
            return token
        }
        return (thinBridgeMode || thinElectronMode) ? BridgeSecurity.mintToken() : nil
    }

    
    
    
    
    
    
    
    
    
    
    static func shouldMountThinBridgeCors(thinBridgeMode: Bool, bridgeToken: String?) -> Bool {
        thinBridgeMode || bridgeToken != nil
    }

    
    
    
    
    static func resolveThinLeaderOrigin(
        config: ServerConfig,
        environment: [String: String]
    ) -> String {
        let explicit = config.leadWorkerBaseUrl ?? environment["WORKER_BASE_URL"]
        if let explicit, !explicit.isEmpty {
            return explicit.replacingOccurrences(
                of: #"/+$"#,
                with: "",
                options: .regularExpression
            )
        }
        
        return "https://www.sliccy.ai"
    }

    
    
    
    
    
    
    
    
    static func resolveBrowserLaunchURL(
        serveOrigin: String,
        config: ServerConfig,
        environment: [String: String],
        bridgeWsUrl: String? = nil,
        bridgeToken: String? = nil
    ) throws -> String {
        if config.lead && config.join {
            throw ValidationError("The --lead and --join launch flows are mutually exclusive.")
        }

        let isThinBridge = bridgeWsUrl != nil && bridgeToken != nil
        let baseHref =
            isThinBridge
            ? Self.resolveThinLeaderOrigin(config: config, environment: environment)
            : serveOrigin

        var launchURL = baseHref
        if config.join {
            guard let joinURL = config.joinUrl else {
                throw ValidationError(
                    "The --join launch flow requires a tray join URL via --join <url> or --join=<url>."
                )
            }
            launchURL = try buildTrayJoinLaunchURL(locationHref: baseHref, joinURL: joinURL)
        } else if config.lead {
            guard
                let workerBaseURL = normalizeTrayWorkerBaseURL(
                    config.leadWorkerBaseUrl ?? environment["WORKER_BASE_URL"]
                )
            else {
                
                
                
                
                
                throw ValidationError(
                    "The --lead launch flow requires a tray worker base URL via --lead-worker-base-url <url> or the WORKER_BASE_URL environment variable."
                )
            }
            launchURL = try buildCanonicalTrayLaunchURL(locationHref: baseHref, trayValue: workerBaseURL)
        }

        if let bridgeWsUrl, let bridgeToken {
            launchURL = try appendQueryItem(
                urlString: launchURL,
                name: BridgeSecurity.wsQueryParam,
                value: bridgeWsUrl
            )
            launchURL = try appendQueryItem(
                urlString: launchURL,
                name: BridgeSecurity.tokenQueryParam,
                value: bridgeToken
            )
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
            var components = URLComponents(string: raw)
        else {
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
            !tokenParts[1].isEmpty
        else {
            return nil
        }

        return ParsedTrayJoinURL(joinURL: normalizedJoinURL)
    }

    static func normalizeTrayWorkerBaseURL(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty,
            var components = URLComponents(string: raw),
            components.scheme != nil,
            components.host != nil
        else {
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
        components.queryItems = queryItems

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

    
    
    
    
    
    
    static func parseEnvFileSecrets(at url: URL) -> [Secret]? {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return EnvFileFormat.secretsFromBlob(content)
    }
}
