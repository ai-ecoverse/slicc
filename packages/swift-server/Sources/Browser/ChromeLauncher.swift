import Foundation
import Logging

private let defaultChromeUserDataDirName = "browser-coding-agent-chrome"
private let defaultServePort = 5710
private let defaultChromeLaunchTimeout: TimeInterval = 15
private let cdpPortRegex = try! NSRegularExpression(
    pattern: #"DevTools listening on ws://[^:]+:(\d+)/"#,
    options: []
)

struct ChromeProcess: @unchecked Sendable {
    let process: Process
    let cdpPort: Int
}

struct ChromeLaunchConfig: Sendable {
    let projectRoot: String?
    let cdpPort: Int
    let launchUrl: String
    let userDataDir: String
    let extensionPath: String?
    let executablePath: String?
    let currentDirectoryPath: String?
    let environment: [String: String]
    let launchTimeout: TimeInterval

    init(
        projectRoot: String? = nil,
        cdpPort: Int,
        launchUrl: String,
        userDataDir: String,
        extensionPath: String? = nil,
        executablePath: String? = nil,
        currentDirectoryPath: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        launchTimeout: TimeInterval = defaultChromeLaunchTimeout
    ) {
        self.projectRoot = projectRoot
        self.cdpPort = cdpPort
        self.launchUrl = launchUrl
        self.userDataDir = userDataDir
        self.extensionPath = extensionPath
        self.executablePath = executablePath
        self.currentDirectoryPath = currentDirectoryPath
        self.environment = environment
        self.launchTimeout = launchTimeout
    }
}

enum ChromeLauncherError: LocalizedError, Sendable {
    case chromeExecutableNotFound
    case invalidChromeExecutable(String)
    case chromeExitedBeforeReportingPort(Int32)
    case timedOutWaitingForPort(TimeInterval)
    case cdpUnavailable(Int)
    /// `/usr/bin/open` returned a non-zero exit code while trying to start
    /// Chrome via LaunchServices. We use `open` so that LaunchServices —
    /// not slicc-server / Sliccstart — becomes Chrome's parent and TCC
    /// responsible process; this matters for camera/microphone access on
    /// macOS, where TCC otherwise blames the closest GUI ancestor for the
    /// hardware request and silently drops it if the ancestor has no
    /// `NS{Camera,Microphone}UsageDescription`.
    case openLaunchFailed(exitCode: Int32, executable: String)
    /// A Chrome instance was already listening on the requested CDP port
    /// when we tried to launch our own. Spawning a second Chrome with the
    /// same user-data-dir would have made the new process hand its URL
    /// off to the existing one and exit 0 immediately, producing the
    /// misleading `chromeExitedBeforeReportingPort` error. Fail fast
    /// instead so the caller (launcher / supervisor / user) can clean
    /// the orphan up.
    case chromeAlreadyRunning(port: Int, browser: String?)

    var errorDescription: String? {
        switch self {
        case .chromeExecutableNotFound:
            return "Could not find Chrome/Chromium. Please install Chrome or set CHROME_PATH."
        case .invalidChromeExecutable(let path):
            return "Chrome executable does not exist at \(path)."
        case .chromeExitedBeforeReportingPort(let code):
            return "Chrome exited with code \(code) before reporting its CDP port."
        case .timedOutWaitingForPort(let timeout):
            return "Timed out waiting for Chrome CDP port (\(Int(timeout * 1000))ms)."
        case .cdpUnavailable(let port):
            return "Chrome CDP endpoint did not become ready on port \(port)."
        case .chromeAlreadyRunning(let port, let browser):
            let tail = browser.map { " (\($0))" } ?? ""
            return "A Chrome instance is already running on CDP port \(port)\(tail). Quit it before starting slicc-server again."
        case .openLaunchFailed(let exitCode, let executable):
            return "/usr/bin/open exited with code \(exitCode) while launching \(executable)."
        }
    }
}

struct ChromeLauncher: Sendable {
    private let logger: Logger
    private let fileExists: @Sendable (String) -> Bool
    private let directoryContents: @Sendable (String) throws -> [String]
    private let environmentProvider: @Sendable () -> [String: String]
    private let currentDirectoryProvider: @Sendable () -> String
    private let homeDirectoryProvider: @Sendable () -> String
    private let processFactory: @Sendable () -> Process
    private let fetchData: @Sendable (URL) async throws -> (Data, URLResponse)

    init(
        logger: Logger = Logger(label: "slicc.chrome-launcher"),
        fileExists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        directoryContents: @escaping @Sendable (String) throws -> [String] = {
            try FileManager.default.contentsOfDirectory(atPath: $0)
        },
        environmentProvider: @escaping @Sendable () -> [String: String] = { ProcessInfo.processInfo.environment },
        currentDirectoryProvider: @escaping @Sendable () -> String = { FileManager.default.currentDirectoryPath },
        homeDirectoryProvider: @escaping @Sendable () -> String = {
            FileManager.default.homeDirectoryForCurrentUser.path
        },
        processFactory: @escaping @Sendable () -> Process = { Process() },
        fetchData: @escaping @Sendable (URL) async throws -> (Data, URLResponse) = { url in
            // Bound every internal HTTP probe (CDP pre-flight, waitForCDP)
            // with an explicit 2 s request timeout. Without this the default
            // URLSession.shared request timeout of ~60 s can stall Chrome
            // launch for a full minute when something is listening on the
            // CDP port but hung at the HTTP layer — well past our own
            // launchTimeout budget.
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            request.cachePolicy = .reloadIgnoringLocalCacheData
            return try await URLSession.shared.data(for: request)
        }
    ) {
        self.logger = logger
        self.fileExists = fileExists
        self.directoryContents = directoryContents
        self.environmentProvider = environmentProvider
        self.currentDirectoryProvider = currentDirectoryProvider
        self.homeDirectoryProvider = homeDirectoryProvider
        self.processFactory = processFactory
        self.fetchData = fetchData
    }

    func findChromeExecutable() -> String? {
        findChromeExecutable(
            projectRoot: nil,
            environment: environmentProvider(),
            currentDirectory: currentDirectoryProvider(),
            homeDirectory: homeDirectoryProvider()
        )
    }

    func buildLaunchArgs(
        cdpPort: Int,
        launchUrl: String,
        userDataDir: String,
        extensionPath: String?
    ) -> [String] {
        var args = [
            "--remote-debugging-port=\(cdpPort)",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-crash-reporter",
            "--disable-background-tracing",
            "--user-data-dir=\(userDataDir)",
        ]

        if let extensionPath, !extensionPath.isEmpty {
            args.append("--disable-extensions-except=\(extensionPath)")
            args.append("--load-extension=\(extensionPath)")
        }

        args.append(launchUrl)
        return args
    }

    /// Compose the argument vector for `/usr/bin/open` that launches the
    /// resolved Chrome `.app` bundle with our Chromium flags. The exact
    /// `-n -a <bundle> -W --args …` shape mirrors `ElectronLauncher`, so
    /// LaunchServices owns the spawned process and Chrome — not
    /// slicc-server — becomes its own TCC responsible process for camera
    /// and microphone access.
    func buildOpenLaunchArgs(
        appBundlePath: String,
        chromeArgs: [String]
    ) -> [String] {
        return ["-n", "-a", appBundlePath, "-W", "--args"] + chromeArgs
    }

    /// Walk up from a Chrome executable path (`…/Foo.app/Contents/MacOS/Foo`)
    /// to its enclosing `.app` bundle. Returns `nil` for bare-binary paths
    /// (which falls back to the direct-exec launch path used in tests).
    func resolveAppBundle(forExecutable executablePath: String) -> String? {
        let url = URL(fileURLWithPath: executablePath)
        let pathComponents = url.pathComponents
        // Look for the deepest path component ending in ".app". Both
        // canonical Chrome ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        // and Chrome for Testing
        // ("~/.cache/puppeteer/chrome/mac-X/chrome-mac-arm64/Google Chrome for Testing.app/…")
        // sit inside a `.app` bundle that LaunchServices can open.
        guard let appIndex = pathComponents.lastIndex(where: { $0.lowercased().hasSuffix(".app") }) else {
            return nil
        }
        return NSString.path(withComponents: Array(pathComponents.prefix(appIndex + 1)))
    }

    func resolveUserDataDir(tmpDir: String? = nil, servePort: Int? = nil) -> String {
        let baseTmpDir = normalizedPath(tmpDir)
            ?? normalizedPath(environmentProvider()["TMPDIR"])
            ?? "/tmp"
        let suffix = (servePort != nil && servePort != defaultServePort) ? "-\(servePort!)" : ""
        return URL(fileURLWithPath: baseTmpDir, isDirectory: true)
            .appendingPathComponent("\(defaultChromeUserDataDirName)\(suffix)", isDirectory: true)
            .path
    }

    func launch(config: ChromeLaunchConfig) async throws -> ChromeProcess {
        let executable = config.executablePath ?? findChromeExecutable(
            projectRoot: config.projectRoot,
            environment: config.environment,
            currentDirectory: config.currentDirectoryPath ?? currentDirectoryProvider(),
            homeDirectory: homeDirectoryProvider()
        )
        guard let executable else {
            throw ChromeLauncherError.chromeExecutableNotFound
        }
        guard fileExists(executable) else {
            throw ChromeLauncherError.invalidChromeExecutable(executable)
        }

        // Fail fast if another Chrome is already listening on the requested
        // CDP port. Spawning our own Chrome with the same user-data-dir in
        // that situation is a trap: the new process hands its URL off to
        // the existing instance via Chrome's single-instance IPC, then
        // exits 0 — and the caller sees the misleading "Chrome exited
        // before reporting its CDP port" error.
        if let existing = await probeExistingChrome(cdpPort: config.cdpPort) {
            logger.warning("Chrome already on CDP port \(config.cdpPort): \(existing)")
            throw ChromeLauncherError.chromeAlreadyRunning(port: config.cdpPort, browser: existing)
        }

        let process = processFactory()
        let chromeArgs = buildLaunchArgs(
            cdpPort: config.cdpPort,
            launchUrl: config.launchUrl,
            userDataDir: config.userDataDir,
            extensionPath: config.extensionPath
        )
        process.environment = config.environment.merging(["GOOGLE_CRASHPAD_DISABLE": "1"]) { _, new in new }
        if let currentDirectoryPath = normalizedPath(config.currentDirectoryPath) {
            process.currentDirectoryURL = URL(fileURLWithPath: currentDirectoryPath, isDirectory: true)
        }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let usesLaunchServices: Bool
        if let appBundlePath = resolveAppBundle(forExecutable: executable) {
            // Route the spawn through `/usr/bin/open` so LaunchServices owns
            // the new Chrome process. Without this, slicc-server (and
            // therefore Sliccstart) stays in Chrome's TCC responsibility
            // chain; macOS then blames our launcher bundle for any
            // camera/microphone access Chrome makes — and silently denies
            // it because the launcher has no NS*UsageDescription. With
            // LaunchServices in the loop, Chrome becomes its own TCC
            // responsible process and the canonical
            // "/Applications/Google Chrome.app" privacy grant applies as
            // users expect.
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = buildOpenLaunchArgs(
                appBundlePath: appBundlePath,
                chromeArgs: chromeArgs
            )
            usesLaunchServices = true
        } else {
            // Fallback for bare-binary paths (largely a test affordance):
            // exec the binary directly and scrape its stderr for the CDP
            // port the way we used to.
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = chromeArgs
            usesLaunchServices = false
        }

        try process.run()
        logger.info("Launched Chrome at \(executable)")

        let actualPort: Int
        if usesLaunchServices {
            actualPort = config.cdpPort
            try await waitForCDPReady(port: actualPort, timeout: config.launchTimeout, process: process)
        } else {
            let outputMonitor = ChromeOutputMonitor(
                process: process,
                stdout: stdoutPipe.fileHandleForReading,
                stderr: stderrPipe.fileHandleForReading,
                logger: logger
            )
            actualPort = try await outputMonitor.awaitPort(timeout: config.launchTimeout)
            _ = try await waitForCDP(port: actualPort)
        }
        logger.info("Chrome CDP listening on port \(actualPort)")
        return ChromeProcess(process: process, cdpPort: actualPort)
    }

    /// Poll Chrome's `/json/version` endpoint until it answers with a CDP
    /// payload or the launch budget runs out. This is the LaunchServices
    /// counterpart to `ChromeOutputMonitor.awaitPort()`: when we spawn
    /// Chrome through `/usr/bin/open`, the open helper is the only thing
    /// connected to our stderr pipe and the CDP `DevTools listening on`
    /// banner never reaches us. We also watch the `open` process so a
    /// non-zero LaunchServices exit fails fast instead of waiting out the
    /// full timeout.
    private func waitForCDPReady(port: Int, timeout: TimeInterval, process: Process) async throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(max(timeout, 0) * 1_000_000_000)
        let pollIntervalNanos: UInt64 = 100_000_000
        let versionURL = URL(string: "http://127.0.0.1:\(port)/json/version")!

        while DispatchTime.now().uptimeNanoseconds < deadline {
            if !process.isRunning {
                let exitCode = process.terminationStatus
                if exitCode != 0 {
                    throw ChromeLauncherError.openLaunchFailed(exitCode: exitCode, executable: "/usr/bin/open")
                }
                // `open` exits 0 once LaunchServices has handed off; keep polling.
            }

            do {
                let (data, response) = try await fetchData(versionURL)
                if let httpResponse = response as? HTTPURLResponse,
                   (200..<300).contains(httpResponse.statusCode),
                   Self.extractWebSocketDebuggerURL(from: data) != nil {
                    return
                }
            } catch {
                // Keep polling — transient connection refused is expected
                // while Chrome boots.
            }

            try await Task.sleep(nanoseconds: pollIntervalNanos)
        }

        throw ChromeLauncherError.timedOutWaitingForPort(timeout)
    }

    func waitForCDP(port: Int, retries: Int = 50, delay: TimeInterval = 0.1) async throws -> String {
        let attempts = max(retries, 1)
        let versionURL = URL(string: "http://127.0.0.1:\(port)/json/version")!

        for attempt in 0..<attempts {
            do {
                let (data, response) = try await fetchData(versionURL)
                if let httpResponse = response as? HTTPURLResponse,
                   (200..<300).contains(httpResponse.statusCode),
                   let webSocketDebuggerURL = Self.extractWebSocketDebuggerURL(from: data) {
                    return webSocketDebuggerURL
                }
            } catch {
                logger.debug("CDP probe attempt \(attempt + 1) failed: \(error.localizedDescription)")
            }

            if attempt + 1 < attempts {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }

        throw ChromeLauncherError.cdpUnavailable(port)
    }

    static func parseCdpPortFromStderr(_ line: String) -> Int? {
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = cdpPortRegex.firstMatch(in: line, options: [], range: range),
              let portRange = Range(match.range(at: 1), in: line),
              let port = Int(line[portRange]),
              port > 0 else {
            return nil
        }
        return port
    }

    private func findChromeExecutable(
        projectRoot: String?,
        environment: [String: String],
        currentDirectory: String,
        homeDirectory: String
    ) -> String? {
        if let environmentPath = normalizedPath(environment["CHROME_PATH"]), fileExists(environmentPath) {
            return resolveMacAppBundle(at: environmentPath) ?? environmentPath
        }

        for candidate in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] where fileExists(candidate) {
            return candidate
        }

        for cacheRoot in chromeForTestingRoots(
            projectRoot: projectRoot,
            environment: environment,
            currentDirectory: currentDirectory,
            homeDirectory: homeDirectory
        ) {
            if let candidate = findChromeForTestingExecutable(in: cacheRoot) {
                return candidate
            }
        }

        return nil
    }

    private func chromeForTestingRoots(
        projectRoot: String?,
        environment: [String: String],
        currentDirectory: String,
        homeDirectory: String
    ) -> [String] {
        var projectRoots: [String] = []
        let currentParent = URL(fileURLWithPath: currentDirectory).deletingLastPathComponent().path

        for candidate in [projectRoot, environment["SLICC_DIR"], currentDirectory, currentParent] {
            guard let candidate = normalizedPath(candidate), !projectRoots.contains(candidate) else { continue }
            projectRoots.append(candidate)
        }

        var roots = projectRoots.flatMap { root in
            [
                URL(fileURLWithPath: root).appendingPathComponent("node_modules/.cache/puppeteer/chrome").path,
                URL(fileURLWithPath: root).appendingPathComponent("node_modules/.cache/puppeteer").path,
            ]
        }
        roots.append(URL(fileURLWithPath: homeDirectory).appendingPathComponent(".cache/puppeteer/chrome").path)
        roots.append(URL(fileURLWithPath: homeDirectory).appendingPathComponent(".cache/puppeteer").path)
        return roots
    }

    private func findChromeForTestingExecutable(in cacheRoot: String) -> String? {
        guard let entries = try? directoryContents(cacheRoot) else {
            return nil
        }

        for entry in entries
            .filter({ $0.lowercased().hasPrefix("mac") })
            .sorted(by: { $0.localizedStandardCompare($1) == .orderedDescending }) {
            for suffix in [
                "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            ] {
                let candidate = URL(fileURLWithPath: cacheRoot)
                    .appendingPathComponent(entry)
                    .appendingPathComponent(suffix)
                    .path
                if fileExists(candidate) {
                    return candidate
                }
            }
        }

        return nil
    }

    private func resolveMacAppBundle(at path: String) -> String? {
        guard path.hasSuffix(".app") else {
            return nil
        }

        let bundleName = URL(fileURLWithPath: path)
            .deletingPathExtension()
            .lastPathComponent
        let candidate = URL(fileURLWithPath: path)
            .appendingPathComponent("Contents/MacOS")
            .appendingPathComponent(bundleName)
            .path
        return fileExists(candidate) ? candidate : nil
    }

    private static func extractWebSocketDebuggerURL(from data: Data) -> String? {
        guard let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = jsonObject["webSocketDebuggerUrl"] as? String,
              !value.isEmpty else {
            return nil
        }
        return value
    }

    static func extractBrowserIdentifier(from data: Data) -> String? {
        guard let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let browser = jsonObject["Browser"] as? String, !browser.isEmpty {
            return browser
        }
        return nil
    }

    /// Issue a single `/json/version` probe against the requested CDP
    /// port. Returns the Browser identifier (e.g. "Chrome/147.0.7727.101")
    /// if a real CDP endpoint answered, or `nil` if nothing is there / it
    /// isn't a CDP-shaped response.
    ///
    /// Kept internal (non-`private`) so tests can exercise it via the
    /// injected `fetchData`.
    func probeExistingChrome(cdpPort: Int) async -> String? {
        guard let versionURL = URL(string: "http://127.0.0.1:\(cdpPort)/json/version") else {
            return nil
        }
        do {
            let (data, response) = try await fetchData(versionURL)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }
            // Require both the Browser field and a CDP websocket URL so we
            // don't misidentify some other HTTP service squatting on the
            // port.
            guard Self.extractWebSocketDebuggerURL(from: data) != nil else {
                return nil
            }
            return Self.extractBrowserIdentifier(from: data)
        } catch {
            logger.debug("CDP pre-flight probe failed: \(error.localizedDescription)")
            return nil
        }
    }
}

private final class ChromeOutputMonitor: @unchecked Sendable {
    private let process: Process
    private let stdout: FileHandle
    private let stderr: FileHandle
    private let logger: Logger
    private let queue = DispatchQueue(label: "slicc.chrome-launcher.output")

    private var stdoutBuffer = ""
    private var stderrBuffer = ""
    private var parsedPort: Int?
    private var settled = false
    private var continuation: CheckedContinuation<Int, Error>?

    init(process: Process, stdout: FileHandle, stderr: FileHandle, logger: Logger) {
        self.process = process
        self.stdout = stdout
        self.stderr = stderr
        self.logger = logger
    }

    func awaitPort(timeout: TimeInterval) async throws -> Int {
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.continuation = continuation
                self.startReading()
                self.queue.asyncAfter(deadline: .now() + timeout) {
                    self.finish(with: .failure(.timedOutWaitingForPort(timeout)))
                }
            }
        }
    }

    private func startReading() {
        stdout.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            // Detach synchronously on EOF: if `self` has already been released,
            // the async hop inside `consumeStdout` becomes a no-op and the
            // handler would otherwise stay armed, busy-looping on the
            // NSFileHandle.fd_monitoring queue.
            if data.isEmpty {
                handle.readabilityHandler = nil
            }
            self?.consumeStdout(data)
        }
        stderr.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            }
            self?.consumeStderr(data)
        }
    }

    private func consumeStdout(_ data: Data) {
        queue.async {
            if data.isEmpty {
                self.stdout.readabilityHandler = nil
                self.logBufferedStdout(final: true)
                return
            }

            self.stdoutBuffer += String(decoding: data, as: UTF8.self)
            self.logBufferedStdout(final: false)
        }
    }

    private func consumeStderr(_ data: Data) {
        queue.async {
            if data.isEmpty {
                self.stderr.readabilityHandler = nil
                self.processStderrBuffer(final: true)
                if self.parsedPort == nil {
                    self.finish(with: .failure(.chromeExitedBeforeReportingPort(self.process.terminationStatus)))
                }
                return
            }

            self.stderrBuffer += String(decoding: data, as: UTF8.self)
            self.processStderrBuffer(final: false)
        }
    }

    private func processStderrBuffer(final: Bool) {
        processLines(in: &stderrBuffer, final: final) { line in
            if self.parsedPort == nil, let port = ChromeLauncher.parseCdpPortFromStderr(line) {
                self.parsedPort = port
                self.finish(with: .success(port))
            }
            if self.parsedPort != nil {
                self.logger.info("chrome stderr: \(line)")
            }
        }
    }

    private func logBufferedStdout(final: Bool) {
        processLines(in: &stdoutBuffer, final: final) { line in
            guard self.parsedPort != nil else { return }
            self.logger.info("chrome stdout: \(line)")
        }
    }

    private func processLines(in buffer: inout String, final: Bool, body: (String) -> Void) {
        while let newlineIndex = buffer.firstIndex(of: "\n") {
            let line = String(buffer[..<newlineIndex]).trimmingCharacters(in: .newlines)
            if !line.isEmpty {
                body(line)
            }
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
        }

        if final, !buffer.isEmpty {
            let line = buffer.trimmingCharacters(in: .newlines)
            if !line.isEmpty {
                body(line)
            }
            buffer.removeAll(keepingCapacity: false)
        }
    }

    private func finish(with result: Result<Int, ChromeLauncherError>) {
        guard !settled else { return }
        settled = true
        let continuation = continuation
        self.continuation = nil

        switch result {
        case .success(let port):
            continuation?.resume(returning: port)
        case .failure(let error):
            continuation?.resume(throwing: error)
        }
    }
}

private func normalizedPath(_ path: String?) -> String? {
    guard let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
        return nil
    }
    return NSString(string: trimmed).expandingTildeInPath
}