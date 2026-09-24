import AppKit
import Foundation
import Logging

private let defaultChromeUserDataDirName = "browser-coding-agent-chrome"
private let defaultServePort = 5710
private let defaultChromeLaunchTimeout: TimeInterval = 15
private let defaultChromePidDiscoveryTimeout: TimeInterval = 5
private let chromePidDiscoveryPollIntervalNanos: UInt64 = 100_000_000
private let cdpPortRegex = try! NSRegularExpression(
    pattern: #"DevTools listening on ws://[^:]+:(\d+)/"#,
    options: []
)

struct ChromeProcess: @unchecked Sendable {
    let process: Process
    let cdpPort: Int
    
    
    
    
    
    
    
    
    let chromePid: pid_t?

    init(process: Process, cdpPort: Int, chromePid: pid_t? = nil) {
        self.process = process
        self.cdpPort = cdpPort
        self.chromePid = chromePid
    }
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
    
    
    
    
    let restoreUrls: [String]

    init(
        projectRoot: String? = nil,
        cdpPort: Int,
        launchUrl: String,
        userDataDir: String,
        extensionPath: String? = nil,
        executablePath: String? = nil,
        currentDirectoryPath: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        launchTimeout: TimeInterval = defaultChromeLaunchTimeout,
        restoreUrls: [String] = []
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
        self.restoreUrls = restoreUrls
    }
}

enum ChromeLauncherError: LocalizedError, Sendable {
    case chromeExecutableNotFound
    case invalidChromeExecutable(String)
    case chromeExitedBeforeReportingPort(Int32)
    case timedOutWaitingForPort(TimeInterval)
    case cdpUnavailable(Int)
    
    
    
    
    
    
    
    case openLaunchFailed(exitCode: Int32, executable: String)
    
    
    
    
    
    
    
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
    private let launchServicesExecutablePath: String
    private let chromePidDiscoveryTimeout: TimeInterval
    private let fetchData: @Sendable (URL) async throws -> (Data, URLResponse)
    
    
    
    
    private let runningPidsForBundle: @Sendable (URL) -> Set<pid_t>

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
        launchServicesExecutablePath: String = "/usr/bin/open",
        chromePidDiscoveryTimeout: TimeInterval = defaultChromePidDiscoveryTimeout,
        fetchData: @escaping @Sendable (URL) async throws -> (Data, URLResponse) = { url in
            
            
            
            
            
            
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            request.cachePolicy = .reloadIgnoringLocalCacheData
            return try await URLSession.shared.data(for: request)
        },
        runningPidsForBundle: @escaping @Sendable (URL) -> Set<pid_t> = { bundleURL in
            let canonical = bundleURL.standardizedFileURL
            return Set(
                NSWorkspace.shared.runningApplications.compactMap { app -> pid_t? in
                    guard let appBundleURL = app.bundleURL?.standardizedFileURL,
                        appBundleURL == canonical,
                        app.processIdentifier > 0
                    else {
                        return nil
                    }
                    return app.processIdentifier
                })
        }
    ) {
        self.logger = logger
        self.fileExists = fileExists
        self.directoryContents = directoryContents
        self.environmentProvider = environmentProvider
        self.currentDirectoryProvider = currentDirectoryProvider
        self.homeDirectoryProvider = homeDirectoryProvider
        self.processFactory = processFactory
        self.launchServicesExecutablePath = launchServicesExecutablePath
        self.chromePidDiscoveryTimeout = chromePidDiscoveryTimeout
        self.fetchData = fetchData
        self.runningPidsForBundle = runningPidsForBundle
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
        extensionPath: String?,
        restoreUrls: [String] = [],
        mockKeychain: Bool = false
    ) -> [String] {
        var args = [
            "--remote-debugging-port=\(cdpPort)",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-crash-reporter",
            "--disable-background-tracing",
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,IntensiveWakeUpThrottling,HighEfficiencyModeAvailable,InfiniteTabsFreezing,InfiniteTabsFreezingOnMemoryPressure,CPUMeasurementInFreezingPolicy,MemoryMeasurementInFreezingPolicy,AllowDevtoolsConnectedDiscard",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--user-data-dir=\(userDataDir)",
        ]

        
        
        
        
        
        
        
        if mockKeychain {
            args.append("--use-mock-keychain")
            args.append("--password-store=basic")
        }

        if let extensionPath, !extensionPath.isEmpty {
            args.append("--disable-extensions-except=\(extensionPath)")
            args.append("--load-extension=\(extensionPath)")
        }

        
        
        
        
        args.append(launchUrl)
        args.append(
            contentsOf: TabSessionStore.sanitize(
                rawUrls: restoreUrls,
                hostedOrigins: []
            )
        )
        return args
    }

    
    
    
    
    
    
    func buildOpenLaunchArgs(
        appBundlePath: String,
        chromeArgs: [String]
    ) -> [String] {
        return ["-n", "-a", appBundlePath, "-W", "--args"] + chromeArgs
    }

    
    
    
    func resolveAppBundle(forExecutable executablePath: String) -> String? {
        let url = URL(fileURLWithPath: executablePath)
        let pathComponents = url.pathComponents
        
        
        
        
        
        guard let appIndex = pathComponents.lastIndex(where: { $0.lowercased().hasSuffix(".app") }) else {
            return nil
        }
        return NSString.path(withComponents: Array(pathComponents.prefix(appIndex + 1)))
    }

    func resolveUserDataDir(tmpDir: String? = nil, servePort: Int? = nil) -> String {
        let baseDir =
            normalizedPath(tmpDir)
            ?? URL(fileURLWithPath: homeDirectoryProvider(), isDirectory: true)
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("Slicc", isDirectory: true)
            .appendingPathComponent("profiles", isDirectory: true)
            .path
        let suffix = (servePort != nil && servePort != defaultServePort) ? "-\(servePort!)" : ""
        return URL(fileURLWithPath: baseDir, isDirectory: true)
            .appendingPathComponent("\(defaultChromeUserDataDirName)\(suffix)", isDirectory: true)
            .path
    }

    
    
    
    func migrateLegacyDefaultChromeProfile(newDir: String, candidates: [String]) {
        guard !FileManager.default.fileExists(atPath: newDir) else { return }
        for candidate in candidates {
            if FileManager.default.fileExists(atPath: candidate) {
                do {
                    let destParent = URL(fileURLWithPath: newDir).deletingLastPathComponent()
                    try FileManager.default.createDirectory(at: destParent, withIntermediateDirectories: true)
                    try FileManager.default.copyItem(atPath: candidate, toPath: newDir)
                    logger.info("Migrated Chrome profile: \(candidate) → \(newDir)")
                } catch {
                    try? FileManager.default.removeItem(atPath: newDir)
                    logger.warning(
                        "Chrome profile migration failed (\(candidate) → \(newDir)): \(error.localizedDescription); continuing with a fresh profile.")
                }
                return
            }
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    func clearChromeSessionRestore(userDataDir: String) {
        let defaultDir = URL(fileURLWithPath: userDataDir, isDirectory: true)
            .appendingPathComponent("Default", isDirectory: true)
        try? FileManager.default.removeItem(at: defaultDir.appendingPathComponent("Sessions", isDirectory: true))
        for name in ["Last Session", "Last Tabs"] {
            try? FileManager.default.removeItem(at: defaultDir.appendingPathComponent(name))
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    func clearChromeRestoreState(userDataDir: String) {
        let prefsPath = URL(fileURLWithPath: userDataDir, isDirectory: true)
            .appendingPathComponent("Default", isDirectory: true)
            .appendingPathComponent("Preferences")
        guard let data = try? Data(contentsOf: prefsPath) else {
            return  
        }
        guard
            let parsed = try? JSONSerialization.jsonObject(with: data),
            var prefs = parsed as? [String: Any]
        else {
            return  
        }
        var profile = prefs["profile"] as? [String: Any] ?? [:]
        if profile["exit_type"] as? String == "Normal", profile["exited_cleanly"] as? Bool == true {
            return  
        }
        profile["exit_type"] = "Normal"
        profile["exited_cleanly"] = true
        prefs["profile"] = profile
        guard let out = try? JSONSerialization.data(withJSONObject: prefs) else { return }
        try? out.write(to: prefsPath)
    }

    
    
    
    static let tabLifecycleExemptSites = ["www.sliccy.ai", "sliccy.ai", "localhost"]

    
    
    
    
    
    
    
    
    
    
    func seedProfilePreferences(userDataDir: String) {
        let defaultDir = URL(fileURLWithPath: userDataDir, isDirectory: true)
            .appendingPathComponent("Default", isDirectory: true)
        let prefsPath = defaultDir.appendingPathComponent("Preferences")
        try? FileManager.default.createDirectory(at: defaultDir, withIntermediateDirectories: true)
        var prefs: [String: Any] = [:]
        if let data = try? Data(contentsOf: prefsPath),
            let parsed = try? JSONSerialization.jsonObject(with: data),
            let existing = parsed as? [String: Any]
        {
            prefs = existing
        }
        prefs["tab_freezing_enabled"] = false
        var performanceTuning = prefs["performance_tuning"] as? [String: Any] ?? [:]
        var highEfficiencyMode = performanceTuning["high_efficiency_mode"] as? [String: Any] ?? [:]
        highEfficiencyMode["state"] = 0
        performanceTuning["high_efficiency_mode"] = highEfficiencyMode
        var tabDiscarding = performanceTuning["tab_discarding"] as? [String: Any] ?? [:]
        var exceptions = (tabDiscarding["exceptions"] as? [Any])?.compactMap { $0 as? String } ?? []
        for site in Self.tabLifecycleExemptSites where !exceptions.contains(site) {
            exceptions.append(site)
        }
        tabDiscarding["exceptions"] = exceptions
        performanceTuning["tab_discarding"] = tabDiscarding
        prefs["performance_tuning"] = performanceTuning
        guard let out = try? JSONSerialization.data(withJSONObject: prefs) else { return }
        try? out.write(to: prefsPath)
    }

    
    
    
    
    
    
    
    func legacyChromeCandidates(profileDirName: String) -> [String] {
        var bases: [String] = []
        let legacyHomeBase = URL(fileURLWithPath: homeDirectoryProvider(), isDirectory: true)
            .appendingPathComponent(".slicc", isDirectory: true)
            .appendingPathComponent("profiles", isDirectory: true)
            .path
        bases.append(legacyHomeBase)
        let env = environmentProvider()
        if let tmpDir = env["TMPDIR"], !bases.contains(tmpDir) {
            bases.append(tmpDir)
        }
        if !bases.contains("/tmp") {
            bases.append("/tmp")
        }
        return bases.map { URL(fileURLWithPath: $0).appendingPathComponent(profileDirName).path }
    }

    func launch(config: ChromeLaunchConfig) async throws -> ChromeProcess {
        let profileDirName = URL(fileURLWithPath: config.userDataDir).lastPathComponent
        migrateLegacyDefaultChromeProfile(
            newDir: config.userDataDir,
            candidates: legacyChromeCandidates(profileDirName: profileDirName)
        )

        let executable =
            config.executablePath
            ?? findChromeExecutable(
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

        
        
        
        
        
        
        if let existing = await probeExistingChrome(cdpPort: config.cdpPort) {
            logger.warning("Chrome already on CDP port \(config.cdpPort): \(existing)")
            throw ChromeLauncherError.chromeAlreadyRunning(port: config.cdpPort, browser: existing)
        }

        
        
        
        clearChromeSessionRestore(userDataDir: config.userDataDir)
        
        
        
        clearChromeRestoreState(userDataDir: config.userDataDir)
        
        
        
        
        seedProfilePreferences(userDataDir: config.userDataDir)

        let process = processFactory()
        let chromeArgs = buildLaunchArgs(
            cdpPort: config.cdpPort,
            launchUrl: config.launchUrl,
            userDataDir: config.userDataDir,
            extensionPath: config.extensionPath,
            restoreUrls: config.restoreUrls,
            mockKeychain: config.environment["SLICC_CHROME_MOCK_KEYCHAIN"] == "1"
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
        let chromeBundleURL: URL?
        let preexistingChromePids: Set<pid_t>
        if let appBundlePath = resolveAppBundle(forExecutable: executable) {
            
            
            
            
            
            
            
            
            
            
            process.executableURL = URL(fileURLWithPath: launchServicesExecutablePath)
            process.arguments = buildOpenLaunchArgs(
                appBundlePath: appBundlePath,
                chromeArgs: chromeArgs
            )
            usesLaunchServices = true
            
            
            
            
            
            let bundleURL = URL(fileURLWithPath: appBundlePath)
            chromeBundleURL = bundleURL
            preexistingChromePids = runningPidsForBundle(bundleURL)
        } else {
            
            
            
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = chromeArgs
            usesLaunchServices = false
            chromeBundleURL = nil
            preexistingChromePids = []
        }

        let outputMonitor = ChromeOutputMonitor(
            process: process,
            stdout: stdoutPipe.fileHandleForReading,
            stderr: stderrPipe.fileHandleForReading,
            logger: logger
        )
        if !usesLaunchServices {
            outputMonitor.start(timeout: config.launchTimeout)
        }

        try process.run()
        logger.info("Launched Chrome at \(executable)")

        let actualPort: Int
        let chromePid: pid_t?
        if usesLaunchServices {
            actualPort = config.cdpPort
            try await waitForCDPReady(port: actualPort, timeout: config.launchTimeout, process: process)
            
            
            
            
            
            
            
            
            if let bundleURL = chromeBundleURL {
                chromePid = await discoverLaunchedChromePid(
                    bundleURL: bundleURL,
                    existingPids: preexistingChromePids,
                    timeout: chromePidDiscoveryTimeout
                )
                if let chromePid {
                    logger.info("Resolved Chrome PID via LaunchServices: \(chromePid)")
                } else {
                    logger.warning(
                        "Could not resolve Chrome PID after \(chromePidDiscoveryTimeout)s; SIGKILL fallback will be a no-op"
                    )
                }
            } else {
                chromePid = nil
            }
        } else {
            actualPort = try await outputMonitor.awaitPort()
            _ = try await waitForCDP(port: actualPort)
            chromePid = nil
        }
        logger.info("Chrome CDP listening on port \(actualPort)")
        return ChromeProcess(process: process, cdpPort: actualPort, chromePid: chromePid)
    }

    
    
    
    
    
    func discoverLaunchedChromePid(
        bundleURL: URL,
        existingPids: Set<pid_t>,
        timeout: TimeInterval
    ) async -> pid_t? {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(max(timeout, 0) * 1_000_000_000)
        while DispatchTime.now().uptimeNanoseconds < deadline {
            let candidates = runningPidsForBundle(bundleURL).subtracting(existingPids)
            if let pid = candidates.min() {
                return pid
            }
            try? await Task.sleep(nanoseconds: chromePidDiscoveryPollIntervalNanos)
        }
        return runningPidsForBundle(bundleURL).subtracting(existingPids).min()
    }

    
    
    
    
    
    
    
    
    private func waitForCDPReady(port: Int, timeout: TimeInterval, process: Process) async throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(max(timeout, 0) * 1_000_000_000)
        let pollIntervalNanos: UInt64 = 100_000_000
        let versionURL = URL(string: "http://127.0.0.1:\(port)/json/version")!

        while DispatchTime.now().uptimeNanoseconds < deadline {
            if !process.isRunning {
                let exitCode = process.terminationStatus
                if exitCode != 0 {
                    throw ChromeLauncherError.openLaunchFailed(
                        exitCode: exitCode,
                        executable: launchServicesExecutablePath
                    )
                }
                
            }

            do {
                let (data, response) = try await fetchData(versionURL)
                if let httpResponse = response as? HTTPURLResponse,
                    (200..<300).contains(httpResponse.statusCode),
                    Self.extractWebSocketDebuggerURL(from: data) != nil
                {
                    return
                }
            } catch {
                
                
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
                    let webSocketDebuggerURL = Self.extractWebSocketDebuggerURL(from: data)
                {
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
            port > 0
        else {
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

        for entry
            in entries
            .filter({ $0.lowercased().hasPrefix("mac") })
            .sorted(by: { $0.localizedStandardCompare($1) == .orderedDescending })
        {
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
            !value.isEmpty
        else {
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

    
    
    
    
    
    
    
    func probeExistingChrome(cdpPort: Int) async -> String? {
        guard let versionURL = URL(string: "http://127.0.0.1:\(cdpPort)/json/version") else {
            return nil
        }
        do {
            let (data, response) = try await fetchData(versionURL)
            guard let httpResponse = response as? HTTPURLResponse,
                (200..<300).contains(httpResponse.statusCode)
            else {
                return nil
            }
            
            
            
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
    private var processExitStatus: Int32?
    private var stderrReachedEOF = false
    private var settled = false
    private let portStream: AsyncThrowingStream<Int, any Error>
    private let portContinuation: AsyncThrowingStream<Int, any Error>.Continuation

    init(process: Process, stdout: FileHandle, stderr: FileHandle, logger: Logger) {
        let (portStream, portContinuation) = AsyncThrowingStream<Int, any Error>.makeStream()
        self.process = process
        self.stdout = stdout
        self.stderr = stderr
        self.logger = logger
        self.portStream = portStream
        self.portContinuation = portContinuation
    }

    func start(timeout: TimeInterval) {
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            self?.queue.async {
                self?.processExitStatus = status
                self?.finishIfExitedWithoutPort()
            }
        }
        startReading()
        queue.asyncAfter(deadline: .now() + timeout) {
            self.finish(with: .failure(.timedOutWaitingForPort(timeout)))
        }
    }

    func awaitPort() async throws -> Int {
        defer { withExtendedLifetime(self) {} }
        var iterator = portStream.makeAsyncIterator()
        guard let port = try await iterator.next() else {
            preconditionFailure("Chrome output monitor finished without a port or error")
        }
        return port
    }

    private func startReading() {
        armStdoutReader()
        armStderrReader()
    }

    private func armStdoutReader() {
        stdout.readabilityHandler = { [weak self] handle in
            handle.readabilityHandler = nil
            guard let self else { return }
            self.queue.async {
                self.consumeStdout(handle.availableData)
            }
        }
    }

    private func armStderrReader() {
        stderr.readabilityHandler = { [weak self] handle in
            handle.readabilityHandler = nil
            guard let self else { return }
            self.queue.async {
                self.consumeStderr(handle.availableData)
            }
        }
    }

    private func consumeStdout(_ data: Data) {
        if data.isEmpty {
            stdout.readabilityHandler = nil
            logBufferedStdout(final: true)
            return
        }

        stdoutBuffer += String(decoding: data, as: UTF8.self)
        logBufferedStdout(final: false)
        armStdoutReader()
    }

    private func consumeStderr(_ data: Data) {
        if data.isEmpty {
            stderr.readabilityHandler = nil
            processStderrBuffer(final: true)
            stderrReachedEOF = true
            finishIfExitedWithoutPort()
            return
        }

        stderrBuffer += String(decoding: data, as: UTF8.self)
        processStderrBuffer(final: false)
        armStderrReader()
    }

    private func finishIfExitedWithoutPort() {
        guard parsedPort == nil, stderrReachedEOF, let processExitStatus else { return }
        finish(with: .failure(.chromeExitedBeforeReportingPort(processExitStatus)))
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

        switch result {
        case .success(let port):
            portContinuation.yield(port)
            portContinuation.finish()
        case .failure(let error):
            portContinuation.finish(throwing: error)
        }
    }
}

private func normalizedPath(_ path: String?) -> String? {
    guard let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
        return nil
    }
    return NSString(string: trimmed).expandingTildeInPath
}
