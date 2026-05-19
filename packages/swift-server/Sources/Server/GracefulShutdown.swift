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
    /// Real Chrome browser-process PID when `browserProcess` wraps
    /// `/usr/bin/open` instead of Chrome itself (the LaunchServices spawn
    /// path used to make macOS TCC attribute camera/mic requests to Chrome
    /// rather than the launcher). `nil` for the direct-exec path, where
    /// `browserProcess.processIdentifier` is already Chrome's PID and the
    /// SIGKILL fallback can use it directly.
    var browserKillPid: pid_t?
    var browserLabel: String
    var cdpPort: Int
    var fileLogger: FileLogger?
    var overlayInjector: (any GracefulShutdownOverlayControlling)?
    var cdpProxy: (any GracefulShutdownChromeProxyControlling)?
    var clientSockets: (any GracefulShutdownClientSocketControlling)?
    var server: (any GracefulShutdownServer)?

    init(
        browserProcess: Process? = nil,
        browserKillPid: pid_t? = nil,
        browserLabel: String,
        cdpPort: Int,
        fileLogger: FileLogger? = nil,
        overlayInjector: (any GracefulShutdownOverlayControlling)? = nil,
        cdpProxy: (any GracefulShutdownChromeProxyControlling)? = nil,
        clientSockets: (any GracefulShutdownClientSocketControlling)? = nil,
        server: (any GracefulShutdownServer)? = nil
    ) {
        self.browserProcess = browserProcess
        self.browserKillPid = browserKillPid
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
        GracefulShutdownLastResortRegistry.register(
            browserProcess: context.browserProcess,
            browserKillPid: context.browserKillPid
        )

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
            await closeBrowser(
                process: browserProcess,
                browserKillPid: context.browserKillPid,
                browserLabel: context.browserLabel,
                cdpPort: context.cdpPort
            )
        }

        GracefulShutdownLastResortRegistry.clearBrowserProcess()
        exitHandler(0)
    }

    private func closeBrowser(
        process: Process,
        browserKillPid: pid_t?,
        browserLabel: String,
        cdpPort: Int
    ) async {
        if process.isRunning {
            do {
                let browserWebSocketURL = try await fetchBrowserWebSocketURL(cdpPort)
                try await sendBrowserCloseCommand(browserWebSocketURL)
            } catch {
                // CDP not available — fall through to the exit wait and forced kill path.
            }

            await waitForBrowserExit(process)

            if process.isRunning {
                // SIGKILL Chrome itself when we know its real PID, not the
                // `/usr/bin/open` helper wrapped by `process`. Without
                // this, the fallback only killed `open` (which had
                // already exited 0 in most cases anyway) and left a
                // hung Chrome holding the user-data-dir and CDP port,
                // breaking the next launch. Fall back to
                // `process.processIdentifier` for the direct-exec path
                // (Linux/Windows-equivalent test runs, bare-binary
                // CHROME_PATH) where it really is Chrome's PID.
                let killPid = (browserKillPid ?? process.processIdentifier)
                if killPid > 0 {
                    _ = killProcess(killPid, SIGKILL)
                }
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
    /// Real Chrome PID when `browserProcess` wraps `/usr/bin/open` —
    /// see `ShutdownContext.browserKillPid` for the full rationale.
    private static var browserKillPid: pid_t?
    private static var gracefulShutdownStarted = false
    private static var didRegisterExitHandler = false

    static func register(browserProcess: Process?, browserKillPid: pid_t? = nil) {
        lock.lock()
        self.browserProcess = browserProcess
        self.browserKillPid = browserKillPid
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
        browserKillPid = nil
        lock.unlock()
    }

    static func performCleanup() {
        let process: Process?
        let killPid: pid_t?
        let shouldCleanup: Bool

        lock.lock()
        process = browserProcess
        killPid = browserKillPid
        shouldCleanup = !gracefulShutdownStarted
        browserProcess = nil
        browserKillPid = nil
        lock.unlock()

        guard shouldCleanup, let process, process.isRunning else { return }

        // Prefer Chrome's real PID (LaunchServices spawn path); fall back
        // to the Process PID for the direct-exec path where they're the
        // same thing.
        let targetPid = killPid ?? process.processIdentifier
        guard targetPid > 0 else { return }
        _ = Darwin.kill(targetPid, SIGKILL)
    }

    static func resetForTesting() {
        lock.lock()
        browserProcess = nil
        browserKillPid = nil
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