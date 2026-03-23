import Foundation
import XCTest
@testable import slicc_server

final class GracefulShutdownHandlerTests: XCTestCase {
    override func tearDown() {
        GracefulShutdownLastResortRegistry.resetForTesting()
        super.tearDown()
    }

    func testRunShutdownSequenceStopsDependenciesAndExitsZero() async {
        let overlay = OverlayControllerSpy()
        let cdpProxy = ChromeProxySpy()
        let clientSockets = ClientSocketSpy()
        let server = ServerSpy()
        let exitRecorder = ExitRecorder()

        let handler = GracefulShutdownHandler(
            fetchBrowserWebSocketURL: { _ in
                XCTFail("browser discovery should not run without a browser process")
                return ""
            },
            sendBrowserCloseCommand: { _ in
                XCTFail("browser close should not run without a browser process")
            },
            exitHandler: { code in
                exitRecorder.record(code)
            }
        )

        await handler.runShutdownSequence(context: ShutdownContext(
            browserLabel: "Chrome",
            cdpPort: 9222,
            overlayInjector: overlay,
            cdpProxy: cdpProxy,
            clientSockets: clientSockets,
            server: server
        ))

        let cdpShutdownCount = await cdpProxy.shutdownCount()
        let clientShutdownCount = await clientSockets.shutdownCount()
        let serverStopCount = await server.stopCount()

        XCTAssertEqual(overlay.stopCountSnapshot(), 1)
        XCTAssertEqual(cdpShutdownCount, 1)
        XCTAssertEqual(clientShutdownCount, 1)
        XCTAssertEqual(serverStopCount, 1)
        XCTAssertEqual(exitRecorder.codeSnapshot(), 0)
    }

    func testRunShutdownSequenceSendsBrowserCloseBeforeForcedKill() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 30"]
        try process.run()
        XCTAssertTrue(process.isRunning)

        let browserEvents = EventRecorder()
        let exitRecorder = ExitRecorder()
        defer {
            if process.isRunning {
                _ = Darwin.kill(process.processIdentifier, SIGKILL)
            }
        }

        let handler = GracefulShutdownHandler(
            fetchBrowserWebSocketURL: { port in
                XCTAssertEqual(port, 9555)
                browserEvents.record("discover")
                return "ws://127.0.0.1:9555/devtools/browser/test"
            },
            sendBrowserCloseCommand: { url in
                XCTAssertEqual(url, "ws://127.0.0.1:9555/devtools/browser/test")
                browserEvents.record("browser-close")
            },
            killProcess: { pid, signal in
                browserEvents.record("kill")
                return Darwin.kill(pid, signal)
            },
            exitHandler: { code in
                exitRecorder.record(code)
            },
            browserExitTimeoutNanoseconds: 100_000_000,
            browserExitPollNanoseconds: 10_000_000
        )

        await handler.runShutdownSequence(context: ShutdownContext(
            browserProcess: process,
            browserLabel: "Chrome",
            cdpPort: 9555
        ))

        XCTAssertEqual(browserEvents.eventsSnapshot(), ["discover", "browser-close", "kill"])
        XCTAssertEqual(exitRecorder.codeSnapshot(), 0)
    }

    func testLastResortCleanupKillsRunningBrowserSynchronously() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 30"]
        try process.run()
        XCTAssertTrue(process.isRunning)

        GracefulShutdownLastResortRegistry.resetForTesting()
        GracefulShutdownLastResortRegistry.register(browserProcess: process)
        GracefulShutdownLastResortRegistry.performCleanup()
        process.waitUntilExit()

        XCTAssertFalse(process.isRunning)
    }
}

private final class OverlayControllerSpy: @unchecked Sendable, GracefulShutdownOverlayControlling {
    private let lock = NSLock()
    private var stopCount = 0

    func stop() {
        lock.lock()
        stopCount += 1
        lock.unlock()
    }

    func stopCountSnapshot() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return stopCount
    }
}

private actor ChromeProxySpy: GracefulShutdownChromeProxyControlling {
    private var count = 0

    func shutdown() async {
        count += 1
    }

    func shutdownCount() -> Int {
        count
    }
}

private actor ClientSocketSpy: GracefulShutdownClientSocketControlling {
    private var count = 0

    func shutdown() async {
        count += 1
    }

    func shutdownCount() -> Int {
        count
    }
}

private actor ServerSpy: GracefulShutdownServer {
    private var count = 0

    func stop() async {
        count += 1
    }

    func stopCount() -> Int {
        count
    }
}

private final class ExitRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var code: Int32?

    func record(_ code: Int32) {
        lock.lock()
        self.code = code
        lock.unlock()
    }

    func codeSnapshot() -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        return code
    }
}

private final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [String] = []

    func record(_ event: String) {
        lock.lock()
        events.append(event)
        lock.unlock()
    }

    func eventsSnapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }
}