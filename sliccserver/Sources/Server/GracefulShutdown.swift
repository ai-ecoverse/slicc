import Darwin
import Dispatch
import Foundation

protocol GracefulShutdownServer: Sendable {
    func stop() async
}

protocol GracefulShutdownOverlayControlling: Sendable {
    func stop()
}

protocol GracefulShutdownChromeProxyControlling: Sendable {
    func shutdown() async
}

protocol GracefulShutdownClientSocketControlling: Sendable {
    func shutdown() async
}

extension ElectronOverlayInjector: GracefulShutdownOverlayControlling {}
extension CDPProxy: GracefulShutdownChromeProxyControlling {}
extension LickSystem: GracefulShutdownClientSocketControlling {}

struct ShutdownContext: @unchecked Sendable {
    var browserProcess: Process?
    var browserLabel: String
    var cdpPort: Int
    var fileLogger: FileLogger?
    var overlayInjector: (any GracefulShutdownOverlayControlling)?
    var cdpProxy: (any GracefulShutdownChromeProxyControlling)?
    var clientSockets: (any GracefulShutdownClientSocketControlling)?
    var server: (any GracefulShutdownServer)?

    init(
        browserProcess: Process? = nil,
        browserLabel: String,
        cdpPort: Int,
        fileLogger: FileLogger? = nil,
        overlayInjector: (any GracefulShutdownOverlayControlling)? = nil,
        cdpProxy: (any GracefulShutdownChromeProxyControlling)? = nil,
        clientSockets: (any GracefulShutdownClientSocketControlling)? = nil,
        server: (any GracefulShutdownServer)? = nil
    ) {
        self.browserProcess = browserProcess
        self.browserLabel = browserLabel
        self.cdpPort = cdpPort
        self.fileLogger = fileLogger
        self.overlayInjector = overlayInjector
        self.cdpProxy = cdpProxy
        self.clientSockets = clientSockets
        self.server = server
    }
}

actor GracefulShutdownHandler {
    private let fetchBrowserWebSocketURL: @Sendable (Int) async throws -> String
    private let sendBrowserCloseCommand: @Sendable (String) async throws -> Void
    private let sleep: @Sendable (UInt64) async throws -> Void
    private let killProcess: @Sendable (pid_t, Int32) -> Int32
    private let exitHandler: @Sendable (Int32) -> Void
    private let browserExitTimeoutNanoseconds: UInt64
    private let browserExitPollNanoseconds: UInt64

    private let signalQueue = DispatchQueue(label: "slicc.graceful-shutdown.signals")
    private var context: ShutdownContext?
    private var installed = false
    private var shuttingDown = false
    private var signalSources: [DispatchSourceSignal] = []

    init(
        fetchBrowserWebSocketURL: @escaping @Sendable (Int) async throws -> String = {
            try await defaultFetchBrowserWebSocketURL(cdpPort: $0)
        },
        sendBrowserCloseCommand: @escaping @Sendable (String) async throws -> Void = {
            try await defaultSendBrowserCloseCommand(browserWebSocketURL: $0)
        },
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
        killProcess: @escaping @Sendable (pid_t, Int32) -> Int32 = { Darwin.kill($0, $1) },
        exitHandler: @escaping @Sendable (Int32) -> Void = { Darwin.exit($0) },
        browserExitTimeoutNanoseconds: UInt64 = 3_000_000_000,
        browserExitPollNanoseconds: UInt64 = 100_000_000
    ) {
        self.fetchBrowserWebSocketURL = fetchBrowserWebSocketURL
        self.sendBrowserCloseCommand = sendBrowserCloseCommand
        self.sleep = sleep
        self.killProcess = killProcess
        self.exitHandler = exitHandler
        self.browserExitTimeoutNanoseconds = browserExitTimeoutNanoseconds
        self.browserExitPollNanoseconds = browserExitPollNanoseconds
    }

    func install(context: ShutdownContext) {
        self.context = context
        GracefulShutdownLastResortRegistry.register(browserProcess: context.browserProcess)

        guard !installed else { return }
        installed = true

        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        self.signalSources = [SIGINT, SIGTERM].map { signalNumber in
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: signalQueue)
            source.setEventHandler { [weak self] in
                guard let self else { return }
                Task {
                    await self.shutdown()
                }
            }
            source.resume()
            return source
        }
    }

    func shutdown() async {
        guard let context else {
            exitHandler(0)
            return
        }
        await self.runShutdownSequence(context: context)
    }

    func runShutdownSequence(context: ShutdownContext) async {
        guard !shuttingDown else { return }
        shuttingDown = true
        GracefulShutdownLastResortRegistry.markGracefulShutdownStarted()

        print("\nShutting down...")
        context.fileLogger?.close()
        context.overlayInjector?.stop()

        if let cdpProxy = context.cdpProxy {
            await cdpProxy.shutdown()
        }
        if let clientSockets = context.clientSockets {
            await clientSockets.shutdown()
        }
        if let server = context.server {
            await server.stop()
        }

        if let browserProcess = context.browserProcess {
            await closeBrowser(process: browserProcess, browserLabel: context.browserLabel, cdpPort: context.cdpPort)
        }

        GracefulShutdownLastResortRegistry.clearBrowserProcess()
        exitHandler(0)
    }

    private func closeBrowser(process: Process, browserLabel: String, cdpPort: Int) async {
        if process.isRunning {
            do {
                let browserWebSocketURL = try await fetchBrowserWebSocketURL(cdpPort)
                try await sendBrowserCloseCommand(browserWebSocketURL)
            } catch {
                // CDP not available — fall through to the exit wait and forced kill path.
            }

            await waitForBrowserExit(process)

            if process.isRunning, process.processIdentifier > 0 {
                _ = killProcess(process.processIdentifier, SIGKILL)
            }
        }

        print("\(browserLabel) closed")
    }

    private func waitForBrowserExit(_ process: Process) async {
        let deadline = DispatchTime.now().uptimeNanoseconds + browserExitTimeoutNanoseconds
        while process.isRunning && DispatchTime.now().uptimeNanoseconds < deadline {
            try? await sleep(browserExitPollNanoseconds)
        }
    }

}

enum GracefulShutdownError: Error, LocalizedError {
    case cdpUnavailable(Int)
    case invalidBrowserWebSocketURL(String)
    case missingBrowserWebSocketURL

    var errorDescription: String? {
        switch self {
        case .cdpUnavailable(let port):
            return "CDP endpoint was unavailable on port \(port)."
        case .invalidBrowserWebSocketURL(let value):
            return "Invalid browser WebSocket URL: \(value)"
        case .missingBrowserWebSocketURL:
            return "Missing browser WebSocket URL in /json/version response."
        }
    }
}

private struct BrowserVersionPayload: Decodable {
    let webSocketDebuggerUrl: String
}

enum GracefulShutdownLastResortRegistry {
    private static let lock = NSLock()
    private static var browserProcess: Process?
    private static var gracefulShutdownStarted = false
    private static var didRegisterExitHandler = false

    static func register(browserProcess: Process?) {
        lock.lock()
        self.browserProcess = browserProcess
        if !didRegisterExitHandler {
            didRegisterExitHandler = true
            atexit(gracefulShutdownLastResortCleanup)
        }
        lock.unlock()
    }

    static func markGracefulShutdownStarted() {
        lock.lock()
        gracefulShutdownStarted = true
        lock.unlock()
    }

    static func clearBrowserProcess() {
        lock.lock()
        browserProcess = nil
        lock.unlock()
    }

    static func performCleanup() {
        let process: Process?
        let shouldCleanup: Bool

        lock.lock()
        process = browserProcess
        shouldCleanup = !gracefulShutdownStarted
        browserProcess = nil
        lock.unlock()

        guard shouldCleanup,
              let process,
              process.isRunning,
              process.processIdentifier > 0 else {
            return
        }

        _ = Darwin.kill(process.processIdentifier, SIGKILL)
    }

    static func resetForTesting() {
        lock.lock()
        browserProcess = nil
        gracefulShutdownStarted = false
        lock.unlock()
    }
}

private func gracefulShutdownLastResortCleanup() {
    GracefulShutdownLastResortRegistry.performCleanup()
}

private func defaultFetchBrowserWebSocketURL(cdpPort: Int) async throws -> String {
    let url = URL(string: "http://127.0.0.1:\(cdpPort)/json/version")!
    var request = URLRequest(url: url)
    request.timeoutInterval = 1

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse,
          (200..<300).contains(httpResponse.statusCode) else {
        throw GracefulShutdownError.cdpUnavailable(cdpPort)
    }

    let payload = try JSONDecoder().decode(BrowserVersionPayload.self, from: data)
    guard !payload.webSocketDebuggerUrl.isEmpty else {
        throw GracefulShutdownError.missingBrowserWebSocketURL
    }
    return payload.webSocketDebuggerUrl
}

private func defaultSendBrowserCloseCommand(browserWebSocketURL: String) async throws {
    guard let url = URL(string: browserWebSocketURL) else {
        throw GracefulShutdownError.invalidBrowserWebSocketURL(browserWebSocketURL)
    }

    let socket = URLSession.shared.webSocketTask(with: url)
    socket.resume()
    defer { socket.cancel(with: .goingAway, reason: nil) }
    try await socket.send(.string(#"{"id":1,"method":"Browser.close"}"#))
}