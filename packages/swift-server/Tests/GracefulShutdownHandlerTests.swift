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

    func testRunShutdownSequencePrefersBrowserKillPidOverProcessIdentifierWhenForcingKill() async throws {
        // Mirror the LaunchServices spawn path: `process` is the long-lived
        // `open -W` helper whose PID is NOT Chrome's. The SIGKILL fallback
        // must target `browserKillPid` (the real Chrome PID) so we don't
        // leave Chrome holding the user-data-dir and CDP port.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 30"]
        try process.run()
        XCTAssertTrue(process.isRunning)
        defer {
            if process.isRunning {
                _ = Darwin.kill(process.processIdentifier, SIGKILL)
            }
        }

        let openPid = process.processIdentifier
        let fakeChromePid: pid_t = 424242
        let killTargets = PidRecorder()
        let exitRecorder = ExitRecorder()

        let handler = GracefulShutdownHandler(
            fetchBrowserWebSocketURL: { _ in throw GracefulShutdownError.cdpUnavailable(9555) },
            sendBrowserCloseCommand: { _ in
                XCTFail("CDP path should not run when fetchBrowserWebSocketURL throws")
            },
            killProcess: { pid, _ in
                killTargets.record(pid)
                return 0
            },
            exitHandler: { code in exitRecorder.record(code) },
            browserExitTimeoutNanoseconds: 50_000_000,
            browserExitPollNanoseconds: 10_000_000
        )

        await handler.runShutdownSequence(context: ShutdownContext(
            browserProcess: process,
            browserKillPid: fakeChromePid,
            browserLabel: "Chrome",
            cdpPort: 9555
        ))

        XCTAssertEqual(killTargets.snapshot(), [fakeChromePid])
        XCTAssertNotEqual(killTargets.snapshot(), [openPid])
        XCTAssertEqual(exitRecorder.codeSnapshot(), 0)
    }

    func testRunShutdownSequenceFallsBackToProcessIdentifierWhenBrowserKillPidIsNil() async throws {
        // Direct-exec path: `process.processIdentifier` IS Chrome's PID,
        // and we should still SIGKILL it when Browser.close can't be
        // delivered. Verifies the LaunchServices change didn't regress
        // the legacy code path.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 30"]
        try process.run()
        XCTAssertTrue(process.isRunning)
        defer {
            if process.isRunning {
                _ = Darwin.kill(process.processIdentifier, SIGKILL)
            }
        }
        let chromePid = process.processIdentifier

        let killTargets = PidRecorder()
        let exitRecorder = ExitRecorder()

        let handler = GracefulShutdownHandler(
            fetchBrowserWebSocketURL: { _ in throw GracefulShutdownError.cdpUnavailable(9556) },
            sendBrowserCloseCommand: { _ in XCTFail("should not reach close") },
            killProcess: { pid, _ in
                killTargets.record(pid)
                return 0
            },
            exitHandler: { code in exitRecorder.record(code) },
            browserExitTimeoutNanoseconds: 50_000_000,
            browserExitPollNanoseconds: 10_000_000
        )

        await handler.runShutdownSequence(context: ShutdownContext(
            browserProcess: process,
            browserLabel: "Chrome",
            cdpPort: 9556
        ))

        XCTAssertEqual(killTargets.snapshot(), [chromePid])
        XCTAssertEqual(exitRecorder.codeSnapshot(), 0)
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

private final class PidRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var pids: [pid_t] = []

    func record(_ pid: pid_t) {
        lock.lock()
        pids.append(pid)
        lock.unlock()
    }

    func snapshot() -> [pid_t] {
        lock.lock()
        defer { lock.unlock() }
        return pids
    }
}