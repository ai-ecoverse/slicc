import Foundation
import Hummingbird
import Logging
import NIOCore
import XCTest

@testable import slicc_server

private final class ChromeFetchSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0

    func fetch(_ url: URL) throws -> (Data, URLResponse) {
        lock.withLock {
            calls += 1
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            if calls == 1 {
                return (Data("{}".utf8), response)
            }
            return (
                Data(#"{"Browser":"Chrome/Test","webSocketDebuggerUrl":"ws:
                response
            )
        }
    }
}

private final class ChromePidSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0

    func snapshot() -> Set<pid_t> {
        lock.withLock {
            calls += 1
            return calls == 1 ? [] : [4242]
        }
    }
}

private final class ChromeProcessBox: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?

    func make() -> Process {
        lock.withLock {
            let value = Process()
            process = value
            return value
        }
    }

    func terminate() {
        lock.withLock {
            if process?.isRunning == true { process?.terminate() }
        }
    }
}

final class ChromeLauncherCoverageTests: XCTestCase {
    private func logger() -> Logger {
        var logger = Logger(label: "chrome-launcher-coverage")
        logger.logLevel = .trace
        return logger
    }

    func testBareExecutableLaunchParsesPortAndWaitsForCDP() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("fake-chrome")
        try makeExecutable(
            at: executable,
            script: """
                #!/bin/sh
                echo before-port
                echo 'DevTools listening on ws://127.0.0.1:9333/devtools/browser/test' >&2
                echo after-port
                echo after-port >&2
                sleep 30
                """
        )
        let fetches = ChromeFetchSequence()
        let launcher = ChromeLauncher(
            logger: logger(),
            fileExists: { $0 == executable.path },
            fetchData: { try fetches.fetch($0) }
        )

        let launched = try await launcher.launch(
            config: ChromeLaunchConfig(
                cdpPort: 9333,
                launchUrl: "https://www.sliccy.ai/",
                userDataDir: root.appendingPathComponent("profile").path,
                extensionPath: root.appendingPathComponent("extension").path,
                executablePath: executable.path,
                currentDirectoryPath: root.path,
                environment: ["TEST_ENV": "yes"],
                launchTimeout: 5,
                restoreUrls: ["https://example.test/"]
            )
        )
        defer {
            launched.process.terminate()
            launched.process.waitUntilExit()
        }

        XCTAssertEqual(launched.cdpPort, 9333)
        XCTAssertNil(launched.chromePid)
        XCTAssertEqual(launched.process.currentDirectoryURL?.standardizedFileURL, root.standardizedFileURL)
        XCTAssertEqual(launched.process.environment?["GOOGLE_CRASHPAD_DISABLE"], "1")
        XCTAssertTrue(launched.process.arguments?.contains("https://example.test/") == true)
    }

    func testLaunchServicesPathUsesInjectedOpenAndResolvesChromePid() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let chromeExecutable =
            root
            .appendingPathComponent("Fake Chrome.app/Contents/MacOS/Fake Chrome")
        let openExecutable = root.appendingPathComponent("fake-open")
        try makeExecutable(at: chromeExecutable, script: "#!/bin/sh\nexit 0\n")
        try makeExecutable(at: openExecutable, script: "#!/bin/sh\nsleep 30\n")
        let fetches = ChromeFetchSequence()
        let pids = ChromePidSequence()
        let launcher = ChromeLauncher(
            logger: logger(),
            fileExists: { $0 == chromeExecutable.path },
            launchServicesExecutablePath: openExecutable.path,
            fetchData: { try fetches.fetch($0) },
            runningPidsForBundle: { _ in pids.snapshot() }
        )

        let launched = try await launcher.launch(
            config: ChromeLaunchConfig(
                cdpPort: 9333,
                launchUrl: "https://www.sliccy.ai/",
                userDataDir: root.appendingPathComponent("profile").path,
                executablePath: chromeExecutable.path,
                launchTimeout: 1
            )
        )
        defer {
            launched.process.terminate()
            launched.process.waitUntilExit()
        }

        XCTAssertEqual(launched.cdpPort, 9333)
        XCTAssertEqual(launched.chromePid, 4242)
        XCTAssertEqual(launched.process.executableURL, openExecutable)
        XCTAssertEqual(Array(launched.process.arguments?.prefix(2) ?? []), ["-n", "-a"])
    }

    func testLaunchServicesContinuesWhenChromePidCannotBeResolved() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let chromeExecutable =
            root
            .appendingPathComponent("Fake Chrome.app/Contents/MacOS/Fake Chrome")
        let openExecutable = root.appendingPathComponent("fake-open")
        try makeExecutable(at: chromeExecutable, script: "#!/bin/sh\nexit 0\n")
        try makeExecutable(at: openExecutable, script: "#!/bin/sh\nsleep 30\n")
        let fetches = ChromeFetchSequence()
        let launcher = ChromeLauncher(
            logger: logger(),
            fileExists: { $0 == chromeExecutable.path },
            launchServicesExecutablePath: openExecutable.path,
            chromePidDiscoveryTimeout: 0,
            fetchData: { try fetches.fetch($0) },
            runningPidsForBundle: { _ in [111] }
        )

        let launched = try await launcher.launch(
            config: ChromeLaunchConfig(
                cdpPort: 9333,
                launchUrl: "https://www.sliccy.ai/",
                userDataDir: root.appendingPathComponent("profile").path,
                executablePath: chromeExecutable.path,
                launchTimeout: 1
            )
        )
        defer {
            launched.process.terminate()
            launched.process.waitUntilExit()
        }

        XCTAssertNil(launched.chromePid)
    }

    func testLaunchServicesFailureAndBareTimeoutSurfaceSpecificErrors() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let chromeExecutable =
            root
            .appendingPathComponent("Fake Chrome.app/Contents/MacOS/Fake Chrome")
        let failingOpen = root.appendingPathComponent("failing-open")
        try makeExecutable(at: chromeExecutable, script: "#!/bin/sh\nexit 0\n")
        try makeExecutable(at: failingOpen, script: "#!/bin/sh\nexit 7\n")
        let fetches = ChromeFetchSequence()
        let failingLauncher = ChromeLauncher(
            logger: logger(),
            fileExists: { $0 == chromeExecutable.path },
            launchServicesExecutablePath: failingOpen.path,
            fetchData: { url in
                let (_, response) = try fetches.fetch(url)
                throw URLError(.cannotConnectToHost, userInfo: ["response": response])
            }
        )

        do {
            _ = try await failingLauncher.launch(
                config: ChromeLaunchConfig(
                    cdpPort: 9333,
                    launchUrl: "https://www.sliccy.ai/",
                    userDataDir: root.appendingPathComponent("failed-profile").path,
                    executablePath: chromeExecutable.path,
                    launchTimeout: 3
                )
            )
            XCTFail("expected openLaunchFailed")
        } catch ChromeLauncherError.openLaunchFailed(let exitCode, let executable) {
            XCTAssertEqual(exitCode, 7)
            XCTAssertEqual(executable, failingOpen.path)
        }

        let sleepingOpen = root.appendingPathComponent("sleeping-open")
        try makeExecutable(at: sleepingOpen, script: "#!/bin/sh\nsleep 30\n")
        let launchServicesProcessBox = ChromeProcessBox()
        let launchServicesTimeout = ChromeLauncher(
            logger: logger(),
            fileExists: { $0 == chromeExecutable.path },
            processFactory: { launchServicesProcessBox.make() },
            launchServicesExecutablePath: sleepingOpen.path,
            fetchData: { _ in throw URLError(.cannotConnectToHost) },
            runningPidsForBundle: { _ in [] }
        )
        defer { launchServicesProcessBox.terminate() }

        do {
            _ = try await launchServicesTimeout.launch(
                config: ChromeLaunchConfig(
                    cdpPort: 9333,
                    launchUrl: "https://www.sliccy.ai/",
                    userDataDir: root.appendingPathComponent("launch-services-timeout-profile").path,
                    executablePath: chromeExecutable.path,
                    launchTimeout: 0.02
                )
            )
            XCTFail("expected LaunchServices timeout")
        } catch ChromeLauncherError.timedOutWaitingForPort(let timeout) {
            XCTAssertEqual(timeout, 0.02)
        }

        let sleepingExecutable = root.appendingPathComponent("silent-chrome")
        try makeExecutable(at: sleepingExecutable, script: "#!/bin/sh\nsleep 30\n")
        let processBox = ChromeProcessBox()
        let timeoutLauncher = ChromeLauncher(
            logger: logger(),
            fileExists: { $0 == sleepingExecutable.path },
            processFactory: { processBox.make() },
            fetchData: { _ in throw URLError(.cannotConnectToHost) }
        )
        defer { processBox.terminate() }

        do {
            _ = try await timeoutLauncher.launch(
                config: ChromeLaunchConfig(
                    cdpPort: 9333,
                    launchUrl: "https://www.sliccy.ai/",
                    userDataDir: root.appendingPathComponent("timeout-profile").path,
                    executablePath: sleepingExecutable.path,
                    launchTimeout: 0.02
                )
            )
            XCTFail("expected timedOutWaitingForPort")
        } catch ChromeLauncherError.timedOutWaitingForPort(let timeout) {
            XCTAssertEqual(timeout, 0.02)
        }
    }

    func testLaunchRejectsMissingAndInvalidExecutables() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let launcher = ChromeLauncher(
            fileExists: { _ in false },
            directoryContents: { _ in [] },
            environmentProvider: { [:] },
            currentDirectoryProvider: { root.path },
            homeDirectoryProvider: { root.path }
        )

        do {
            _ = try await launcher.launch(
                config: ChromeLaunchConfig(
                    cdpPort: 9333,
                    launchUrl: "https://www.sliccy.ai/",
                    userDataDir: root.appendingPathComponent("missing-profile").path
                )
            )
            XCTFail("expected chromeExecutableNotFound")
        } catch ChromeLauncherError.chromeExecutableNotFound {}

        do {
            _ = try await launcher.launch(
                config: ChromeLaunchConfig(
                    cdpPort: 9333,
                    launchUrl: "https://www.sliccy.ai/",
                    userDataDir: root.appendingPathComponent("invalid-profile").path,
                    executablePath: root.appendingPathComponent("missing-chrome").path
                )
            )
            XCTFail("expected invalidChromeExecutable")
        } catch ChromeLauncherError.invalidChromeExecutable(let path) {
            XCTAssertTrue(path.hasSuffix("missing-chrome"))
        }
    }

    func testDefaultFetchAndDirectoryLookupUseRealSystemBoundaries() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let cacheRoot = root.appendingPathComponent("node_modules/.cache/puppeteer/chrome")
        let executable = cacheRoot.appendingPathComponent(
            "mac-999/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        )
        try makeExecutable(at: executable, script: "#!/bin/sh\nexit 0\n")
        let directoryLauncher = ChromeLauncher(
            fileExists: { $0 == executable.path },
            environmentProvider: { ["SLICC_DIR": root.path] },
            currentDirectoryProvider: { root.path },
            homeDirectoryProvider: { root.path }
        )
        XCTAssertEqual(directoryLauncher.findChromeExecutable(), executable.path)

        let appBundle = root.appendingPathComponent("Custom.app")
        let bundleExecutable = appBundle.appendingPathComponent("Contents/MacOS/Custom")
        try makeExecutable(at: bundleExecutable, script: "#!/bin/sh\nexit 0\n")
        let bundleLauncher = ChromeLauncher(
            fileExists: { $0 == appBundle.path || $0 == bundleExecutable.path },
            environmentProvider: { ["CHROME_PATH": appBundle.path] }
        )
        XCTAssertEqual(bundleLauncher.findChromeExecutable(), bundleExecutable.path)

        let port = try await findAvailablePort(startingFrom: 63_700)
        let router = Router()
        router.get("/json/version") { _, _ in
            Response(
                status: .ok,
                headers: [.contentType: "application/json"],
                body: .init(
                    byteBuffer: ByteBuffer(
                        string: #"{"Browser":"Chrome/default-fetch","webSocketDebuggerUrl":"ws:
                    ))
            )
        }
        let app = Application(
            router: router,
            configuration: .init(address: .hostname("127.0.0.1", port: port))
        )
        let serviceTask = Task { try? await app.runService() }
        defer { serviceTask.cancel() }
        try await waitForHTTPServer(port: port)

        let browser = await ChromeLauncher(logger: logger()).probeExistingChrome(cdpPort: port)
        XCTAssertEqual(browser, "Chrome/default-fetch")
    }

    func testMigrationFailureWaitFailureAndPrivateLookupEdges() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = root.appendingPathComponent("legacy")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        let blockedParent = root.appendingPathComponent("not-a-directory")
        try Data("file".utf8).write(to: blockedParent)
        ChromeLauncher(logger: logger()).migrateLegacyDefaultChromeProfile(
            newDir: blockedParent.appendingPathComponent("profile").path,
            candidates: [legacy.path]
        )

        let unavailable = ChromeLauncher(
            logger: logger(),
            fetchData: { _ in throw URLError(.cannotConnectToHost) }
        )
        do {
            _ = try await unavailable.waitForCDP(port: 1, retries: 1, delay: 0)
            XCTFail("expected unavailable CDP")
        } catch ChromeLauncherError.cdpUnavailable(let port) {
            XCTAssertEqual(port, 1)
        }

        let throwingDirectory = ChromeLauncher(
            fileExists: { _ in false },
            directoryContents: { _ in throw CocoaError(.fileReadNoSuchFile) },
            environmentProvider: { [:] },
            currentDirectoryProvider: { root.path },
            homeDirectoryProvider: { root.path }
        )
        XCTAssertNil(throwingDirectory.findChromeExecutable())
        XCTAssertNil(ChromeLauncher.extractBrowserIdentifier(from: Data("not-json".utf8)))
        XCTAssertNil(
            ChromeLauncher.extractBrowserIdentifier(
                from: Data(#"{"Browser":""}"#.utf8)
            ))

        let url = URL(string: "http://127.0.0.1:9333/json/version")!
        let nonHTTPResponse = URLResponse(
            url: url,
            mimeType: "application/json",
            expectedContentLength: 0,
            textEncodingName: nil
        )
        let nonHTTP = ChromeLauncher(fetchData: { _ in (Data(), nonHTTPResponse) })
        let browser = await nonHTTP.probeExistingChrome(cdpPort: 9333)
        XCTAssertNil(browser)
    }

    func testOutputMonitorFlushesPartialFinalLineAndReportsEarlyExit() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let response = HTTPURLResponse(
            url: URL(string: "http://127.0.0.1:9333/json/version")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )!
        let payload = Data(#"{"webSocketDebuggerUrl":"ws:
        let partial = root.appendingPathComponent("partial-chrome")
        try makeExecutable(
            at: partial,
            script: "#!/bin/sh\nprintf 'DevTools listening on ws://127.0.0.1:9333/devtools/browser/test' >&2\n"
        )
        let launched = try await ChromeLauncher(
            logger: logger(),
            fileExists: { $0 == partial.path },
            fetchData: { _ in (payload, response) }
        ).launch(
            config: .init(
                cdpPort: 9333,
                launchUrl: "https://www.sliccy.ai/",
                userDataDir: root.appendingPathComponent("partial-profile").path,
                executablePath: partial.path,
                launchTimeout: 1
            ))
        XCTAssertEqual(launched.cdpPort, 9333)

        let earlyExit = root.appendingPathComponent("early-exit-chrome")
        try makeExecutable(at: earlyExit, script: "#!/bin/sh\nexit 9\n")
        do {
            _ = try await ChromeLauncher(fileExists: { $0 == earlyExit.path }).launch(
                config: .init(
                    cdpPort: 9334,
                    launchUrl: "https://www.sliccy.ai/",
                    userDataDir: root.appendingPathComponent("early-profile").path,
                    executablePath: earlyExit.path,
                    launchTimeout: 1
                ))
            XCTFail("expected early exit")
        } catch ChromeLauncherError.chromeExitedBeforeReportingPort(let status) {
            XCTAssertEqual(status, 9)
        }
    }

    private func waitForHTTPServer(port: Int) async throws {
        let url = URL(string: "http://127.0.0.1:\(port)/json/version")!
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if (try? await URLSession.shared.data(from: url)) != nil { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Chrome fixture did not start")
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("chrome-launcher-coverage-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeExecutable(at url: URL, script: String) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(script.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }
}
