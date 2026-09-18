import Foundation
import Logging
import XCTest

@testable import slicc_server

private final class ElectronLauncherURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (URLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.cannotConnectToHost) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class ElectronRuntimeCoverageTests: XCTestCase {
    private func logger() -> Logger {
        var logger = Logger(label: "electron-runtime-coverage")
        logger.logLevel = .trace
        return logger
    }

    override func tearDown() {
        ElectronLauncherURLProtocol.handler = nil
        super.tearDown()
    }

    func testBareAndBundleLaunchesReachCDP() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let bareExecutable = root.appendingPathComponent("FakeElectron")
        let bundleExecutable = root.appendingPathComponent("Demo.app/Contents/MacOS/Demo")
        let fakeOpen = root.appendingPathComponent("fake-open")
        for executable in [bareExecutable, bundleExecutable, fakeOpen] {
            try makeExecutable(at: executable, script: "#!/bin/sh\nsleep 30\n")
        }
        let session = makeSession(statusCode: 200, body: Data("{}".utf8))

        let bare = try await ElectronLauncher(session: session, logger: logger()).launch(
            appPath: bareExecutable.path,
            cdpPort: 9333,
            kill: false
        )
        defer {
            bare.process.terminate()
            bare.process.waitUntilExit()
        }
        XCTAssertEqual(bare.cdpPort, 9333)
        XCTAssertEqual(bare.displayName, "FakeElectron")
        XCTAssertEqual(bare.process.executableURL, bareExecutable)
        XCTAssertEqual(bare.process.arguments, ["--remote-debugging-port=9333"])

        let bundled = try await ElectronLauncher(
            session: session,
            logger: logger(),
            launchServicesExecutablePath: fakeOpen.path
        ).launch(
            appPath: bundleExecutable.deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().path,
            cdpPort: 9444,
            kill: false
        )
        defer {
            bundled.process.terminate()
            bundled.process.waitUntilExit()
        }
        XCTAssertEqual(bundled.displayName, "Demo")
        XCTAssertEqual(bundled.process.executableURL, fakeOpen)
        XCTAssertEqual(Array(bundled.process.arguments?.prefix(2) ?? []), ["-n", "-a"])
        XCTAssertTrue(bundled.process.arguments?.contains("--remote-debugging-port=9444") == true)
    }

    func testEarlyProcessExitReportsRemoteDebuggingDisabled() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("DisabledElectron")
        try makeExecutable(at: executable, script: "#!/bin/sh\nexit 9\n")
        let session = makeSession(error: URLError(.cannotConnectToHost))

        do {
            _ = try await ElectronLauncher(session: session, logger: logger()).launch(
                appPath: executable.path,
                cdpPort: 9555,
                kill: false
            )
            XCTFail("expected remote debugging failure")
        } catch ElectronLaunchError.remotDebuggingDisabled(let message) {
            XCTAssertTrue(message.contains("exited with code 9"))
            XCTAssertTrue(message.contains("EnableNodeCliInspectArguments"))
        }
    }

    func testOverlaySyncAddsReusesAndDropsSessions() async throws {
        let target = ElectronInspectableTarget(
            type: "page",
            title: "Demo",
            url: "https://app.example.test/home",
            webSocketDebuggerURL: "ws://127.0.0.1:1/devtools/page/demo"
        )
        let targetsData = try JSONEncoder().encode([target])
        let session = makeSession(statusCode: 200, body: targetsData)
        let injector = ElectronOverlayInjector(
            _testingServePort: 5710,
            cdpPort: 9333,
            probeDelayNanoseconds: 0,
            session: session,
            logger: logger()
        )

        try await injector.syncTargets()
        try await injector.syncTargets()
        XCTAssertEqual(injector._testing_leaderTargetURL(), target.url)

        ElectronLauncherURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                Data("[]".utf8)
            )
        }
        try await injector.syncTargets()
        XCTAssertNil(injector._testing_leaderTargetURL())
        injector._testing_closeConnections()
    }

    func testOverlayPollingAndErrorPathsAreBounded() async throws {
        let injector = ElectronOverlayInjector(
            _testingServePort: 5710,
            cdpPort: 9333,
            probeDelayNanoseconds: 0,
            session: makeSession(statusCode: 503, body: Data()),
            logger: logger()
        )

        do {
            try await injector.syncTargets()
            XCTFail("expected unavailable target list")
        } catch ElectronLaunchError.cdpNotAvailable(let message) {
            XCTAssertTrue(message.contains("9333"))
        }

        injector.start()
        injector.start()
        try await Task.sleep(nanoseconds: 20_000_000)
        injector.stop()
        injector.stop()

        let target = ElectronInspectableTarget(
            type: "page",
            title: nil,
            url: "https://app.example.test/",
            webSocketDebuggerURL: nil
        )
        let session = try injector._testing_connectToTarget(target)
        session.stop()
        injector._testing_closeConnections()
    }

    func testTerminationWaitAndCDPAvailabilityFailureBoundaries() async throws {
        let launcher = ElectronLauncher(logger: logger())
        let emptyApplicationsTerminated = await launcher.waitForApplicationsToTerminate(
            [],
            timeoutNanoseconds: 1
        )
        XCTAssertTrue(emptyApplicationsTerminated)

        let runningApplication = try XCTUnwrap(
            NSWorkspace.shared.runningApplications.first { !$0.isTerminated }
        )
        let currentApplicationTerminated = await launcher.waitForApplicationsToTerminate(
            [runningApplication],
            timeoutNanoseconds: 0
        )
        XCTAssertFalse(currentApplicationTerminated)

        let session = makeSession(statusCode: 503, body: Data())
        do {
            try await waitForCDPAvailability(
                cdpPort: 1,
                session: session,
                logger: logger(),
                retries: 1,
                delayNanoseconds: 0
            )
            XCTFail("expected CDP availability failure")
        } catch ElectronLaunchError.cdpNotAvailable(let message) {
            XCTAssertTrue(message.contains("port 1"))
        }
    }

    private func makeSession(
        statusCode: Int? = nil,
        body: Data = Data(),
        error: Error? = nil
    ) -> URLSession {
        ElectronLauncherURLProtocol.handler = { request in
            if let error { throw error }
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: statusCode ?? 200,
                    httpVersion: nil,
                    headerFields: nil
                )!,
                body
            )
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ElectronLauncherURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("electron-runtime-coverage-\(UUID().uuidString)", isDirectory: true)
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
