import Darwin
import Foundation
import Hummingbird
import HummingbirdWebSocket
import NIOCore
import XCTest

@testable import slicc_server

private final class BrowserCloseBox: @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [String] = []
    func add(_ message: String) { lock.withLock { messages.append(message) } }
    func snapshot() -> [String] { lock.withLock { messages } }
}

final class GracefulShutdownRuntimeTests: XCTestCase {
    func testDefaultBrowserDiscoveryAndCloseUseRealLoopbackEndpoints() async throws {
        let port = try await findAvailablePort(startingFrom: 63_300)
        let messages = BrowserCloseBox()
        let router = Router()
        router.get("/health") { _, _ in "ok" }
        router.get("/json/version") { _, _ in
            Response(
                status: .ok,
                headers: [.contentType: "application/json"],
                body: .init(
                    byteBuffer: ByteBuffer(
                        string: #"{"webSocketDebuggerUrl":"ws://127.0.0.1:\#(port)/devtools/browser/runtime"}"#
                    ))
            )
        }
        let wsRouter = Router(context: BasicWebSocketRequestContext.self)
        wsRouter.ws("/devtools/browser/runtime") { _, _ in
            .upgrade()
        } onUpgrade: { inbound, _, _ in
            for try await message in inbound.messages(maxSize: 1024) {
                if case .text(let text) = message { messages.add(text) }
            }
        }
        let app = Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: wsRouter,
                configuration: .init(maxFrameSize: 2048)
            ),
            configuration: .init(address: .hostname("127.0.0.1", port: port))
        )
        let serviceTask = Task { try? await app.runService() }
        defer { serviceTask.cancel() }
        try await waitForShutdownServer(port: port)

        let socketURL = try await defaultFetchBrowserWebSocketURL(cdpPort: port)
        XCTAssertEqual(socketURL, "ws://127.0.0.1:\(port)/devtools/browser/runtime")
        try await defaultSendBrowserCloseCommand(browserWebSocketURL: socketURL)
        try await waitUntil("Browser.close frame") { !messages.snapshot().isEmpty }
        XCTAssertEqual(messages.snapshot(), [#"{"id":1,"method":"Browser.close"}"#])

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 30"]
        try process.run()
        defer {
            if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
        }
        let codes = ShutdownExitCodes()
        let handler = GracefulShutdownHandler(
            exitHandler: { codes.add($0) },
            browserExitTimeoutNanoseconds: 20_000_000,
            browserExitPollNanoseconds: 1_000_000
        )
        await handler.runShutdownSequence(
            context: ShutdownContext(
                browserProcess: process,
                browserLabel: "Chrome",
                cdpPort: port
            )
        )
        process.waitUntilExit()
        XCTAssertEqual(codes.snapshot(), [0])
    }

    func testDefaultDiscoveryRejectsBadStatusAndMissingSocketURL() async throws {
        for responseBody in ["status", "empty"] {
            let port = try await findAvailablePort(startingFrom: 63_350)
            let router = Router()
            router.get("/json/version") { _, _ in
                if responseBody == "status" {
                    return Response(status: .serviceUnavailable)
                }
                return Response(
                    status: .ok,
                    headers: [.contentType: "application/json"],
                    body: .init(byteBuffer: ByteBuffer(string: #"{"webSocketDebuggerUrl":""}"#))
                )
            }
            let app = Application(
                router: router,
                configuration: .init(address: .hostname("127.0.0.1", port: port))
            )
            let serviceTask = Task { try? await app.runService() }
            try await waitForShutdownServer(port: port)
            do {
                _ = try await defaultFetchBrowserWebSocketURL(cdpPort: port)
                XCTFail("expected discovery failure")
            } catch let error as GracefulShutdownError {
                if responseBody == "status" {
                    guard case .cdpUnavailable = error else { return XCTFail("unexpected \(error)") }
                } else {
                    guard case .missingBrowserWebSocketURL = error else { return XCTFail("unexpected \(error)") }
                }
            }
            serviceTask.cancel()
        }

        do {
            try await defaultSendBrowserCloseCommand(browserWebSocketURL: "http://[")
            XCTFail("expected invalid URL")
        } catch GracefulShutdownError.invalidBrowserWebSocketURL {
            // Expected.
        }
    }

    func testShutdownAndDetachWithoutInstalledContextExitCleanly() async {
        let codes = ShutdownExitCodes()
        let shutdown = GracefulShutdownHandler(exitHandler: { codes.add($0) })
        await shutdown.shutdown()
        let detach = GracefulShutdownHandler(exitHandler: { codes.add($0) })
        await detach.detach()
        XCTAssertEqual(codes.snapshot(), [0, 0])
    }

    private func waitForShutdownServer(port: Int) async throws {
        let url = URL(string: "http://127.0.0.1:\(port)/json/version")!
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if (try? await URLSession.shared.data(from: url)) != nil { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("shutdown fixture did not start")
    }
}

private final class ShutdownExitCodes: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int32] = []
    func add(_ value: Int32) { lock.withLock { values.append(value) } }
    func snapshot() -> [Int32] { lock.withLock { values } }
}
