import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOCore
import NIOWebSocket
import XCTest

@testable import slicc_server

private final class ProxyMessageBox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    func add(_ message: ProxyMessage) {
        lock.withLock {
            switch message {
            case .text(let text): values.append(text)
            case .binary(let buffer): values.append("<binary \(buffer.readableBytes)>")
            }
        }
    }

    func snapshot() -> [String] { lock.withLock { values } }
}

private final class SocketOpenState: @unchecked Sendable {
    private let lock = NSLock()
    private var open = true
    private var closes = 0

    func isOpen() -> Bool { lock.withLock { open } }
    func setOpen(_ value: Bool) { lock.withLock { open = value } }
    func close() {
        lock.withLock {
            open = false
            closes += 1
        }
    }
    func closeCount() -> Int { lock.withLock { closes } }
}

final class CDPProxyRuntimeCoverageTests: XCTestCase {
    private func logger(_ label: String = "cdp-proxy-runtime-coverage") -> Logger {
        var logger = Logger(label: label)
        logger.logLevel = .trace
        return logger
    }

    func testDefaultChromeConnectorRoundTripsTextAndBinaryOverRealSocket() async throws {
        let port = try await findAvailablePort(startingFrom: 63_000)
        let serviceTask = Task { try? await makeChromeApp(port: port).runService() }
        defer { serviceTask.cancel() }
        try await waitForServer(port: port)

        let received = ProxyMessageBox()
        let client = ClientHandle(
            send: { received.add($0) },
            close: { _, _ in }
        )
        let proxy = CDPProxy(
            logger: logger(),
            discoverer: { _ in "ws://127.0.0.1:\(port)/devtools/browser/test" },
            reconnectDelayNanoseconds: 10_000_000_000
        )

        try await proxy.preWarm(cdpPort: port)
        await proxy.addClient(client)
        await proxy.prepareClientConnection(for: client.id, cdpPort: port)
        await proxy.receive(.text(#"{"id":1,"method":"Runtime.enable"}"#), from: client.id)
        await proxy.receive(.binary(ByteBuffer(bytes: [4, 5, 6])), from: client.id)

        try await waitUntil("Chrome text and binary frames to arrive") {
            let snapshot = received.snapshot()
            return snapshot.contains(#"{"id":1,"result":{}}"#)
                && snapshot.contains("<binary 3>")
        }
        XCTAssertFalse(
            received.snapshot().contains { $0.contains("Network.webSocketFrameReceived") }
        )
        await proxy.shutdown()
    }

    func testInstalledRouteBridgesARealWebSocketClient() async throws {
        let port = try await findAvailablePort(startingFrom: 63_400)
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: logger("cdp-proxy-installed-route"),
            discoverer: { _ in "ws://fixture/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let serviceTask = Task { try? await makeProxyApp(port: port, proxy: proxy).runService() }
        defer {
            serviceTask.cancel()
            Task { await proxy.shutdown() }
        }
        try await waitForServer(port: port)

        let socket = URLSession.shared.webSocketTask(
            with: URL(string: "ws://127.0.0.1:\(port)/cdp")!
        )
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        try await waitUntil("the installed route to connect to Chrome") {
            harness.connectCountSnapshot() == 1
        }

        try await socket.send(.string(#"{"id":41,"method":"Runtime.enable"}"#))
        try await socket.send(.data(Data([7, 8, 9])))
        try await waitUntil("client frames to reach the Chrome transport") {
            let sent = harness.sentTextsSnapshot()
            return sent.contains(#"{"id":41,"method":"Runtime.enable"}"#)
                && sent.contains("<binary 3>")
        }

        await harness.emitText(#"{"id":41,"result":{}}"#)
        guard case .string(let text) = try await socket.receive() else {
            return XCTFail("expected a text response")
        }
        XCTAssertEqual(text, #"{"id":41,"result":{}}"#)

        await harness.emitBinary([9, 8, 7])
        guard case .data(let data) = try await socket.receive() else {
            return XCTFail("expected a binary response")
        }
        XCTAssertEqual(data, Data([9, 8, 7]))
        await proxy.shutdown()
    }

    func testDefaultDiscoveryHandlesSuccessStatusFailureAndMissingURL() async throws {
        enum Fixture: Equatable {
            case success, badStatus, missingURL
        }

        for (offset, fixture) in [Fixture.success, .badStatus, .missingURL].enumerated() {
            let port = try await findAvailablePort(startingFrom: 63_500 + offset * 10)
            let router = Router()
            router.get("/health") { _, _ in "ok" }
            router.get("/json/version") { _, _ in
                switch fixture {
                case .success:
                    return Response(
                        status: .ok,
                        headers: [.contentType: "application/json"],
                        body: .init(
                            byteBuffer: ByteBuffer(
                                string: #"{"webSocketDebuggerUrl":"ws:
                            ))
                    )
                case .badStatus:
                    return Response(status: .serviceUnavailable)
                case .missingURL:
                    return Response(
                        status: .ok,
                        headers: [.contentType: "application/json"],
                        body: .init(byteBuffer: ByteBuffer(string: #"{"webSocketDebuggerUrl":""}"#))
                    )
                }
            }
            let app = Application(
                router: router,
                configuration: .init(address: .hostname("127.0.0.1", port: port))
            )
            let serviceTask = Task { try? await app.runService() }
            try await waitForServer(port: port)

            let proxy = CDPProxy(logger: logger())
            do {
                let url = try await proxy.discoverCDPUrl(port: port)
                XCTAssertEqual(fixture, .success)
                XCTAssertEqual(url, "ws://fixture/devtools/browser/default")
            } catch let error as CDPProxyError {
                switch fixture {
                case .success:
                    XCTFail("unexpected discovery failure: \(error)")
                case .badStatus:
                    XCTAssertTrue(error.localizedDescription.contains("Unexpected status 503"))
                case .missingURL:
                    XCTAssertTrue(error.localizedDescription.contains("Missing webSocketDebuggerUrl"))
                }
            }
            serviceTask.cancel()
        }
    }

    func testConnectionTaskReuseStaleSocketReplacementAndGenerationCancellation() async throws {
        let held = ChromeConnectorHarness(waitForExplicitResume: true)
        let proxy = CDPProxy(
            logger: logger(),
            discoverer: { _ in "ws://held" },
            chromeConnector: { url, onMessage, onEvent in
                try await held.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let first = Task { try await proxy.ensureChromeConnection(url: "ws://held") }
        try await waitUntil("the held Chrome connection to begin") {
            held.connectCountSnapshot() == 1
        }
        let second = Task { try await proxy.ensureChromeConnection(url: "ws://held") }
        await held.resumePendingConnection()
        try await first.value
        try await second.value
        XCTAssertEqual(held.connectCountSnapshot(), 1)

        let state = SocketOpenState()
        let connectorCalls = LockedInt()
        let replacementProxy = CDPProxy(
            logger: logger(),
            discoverer: { _ in "ws://replacement" },
            chromeConnector: { _, _, _ in
                connectorCalls.increment()
                return ChromeSocketHandle(
                    send: { _ in },
                    close: { state.close() },
                    isOpen: { state.isOpen() }
                )
            }
        )
        try await replacementProxy.preWarm(cdpPort: 9222)
        state.setOpen(false)
        try await replacementProxy.ensureChromeConnection(url: "ws://replacement")
        XCTAssertEqual(connectorCalls.value, 2)
        XCTAssertGreaterThanOrEqual(state.closeCount(), 1)

        let canceledHarness = ChromeConnectorHarness(waitForExplicitResume: true)
        let canceledProxy = CDPProxy(
            logger: logger(),
            chromeConnector: { url, onMessage, onEvent in
                try await canceledHarness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let pending = Task { try await canceledProxy.ensureChromeConnection(url: "ws://canceled") }
        try await waitUntil("the cancelable Chrome connection to begin") {
            canceledHarness.connectCountSnapshot() == 1
        }
        await canceledProxy.shutdown()
        await canceledHarness.resumePendingConnection()
        try await pending.value

        let reconnectHarness = ChromeConnectorHarness()
        let reconnectingProxy = CDPProxy(
            logger: logger(),
            discoverer: { _ in "ws://reconnect" },
            chromeConnector: { url, onMessage, onEvent in
                try await reconnectHarness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 1_000_000
        )
        try await reconnectingProxy.preWarm(cdpPort: 9222)
        await reconnectHarness.emitEvent(.closed("exercise default sleep"))
        try await waitUntil("the default reconnect delay to elapse") {
            reconnectHarness.connectCountSnapshot() >= 2
        }
        await reconnectingProxy.shutdown()
    }

    func testSendAndClientFailuresDropTheBrokenLegs() async throws {
        let reconnectAttempts = LockedInt()
        let proxy = CDPProxy(
            logger: logger(),
            discoverer: { _ in "ws://send-failure" },
            chromeConnector: { _, _, _ in
                reconnectAttempts.increment()
                return ChromeSocketHandle(
                    send: { _ in throw URLError(.networkConnectionLost) },
                    close: {},
                    isOpen: { true }
                )
            },
            reconnectDelayNanoseconds: 0,
            sleep: { _ in throw CancellationError() }
        )
        let client = ClientHandle(send: { _ in }, close: { _, _ in })
        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(client)
        await proxy.prepareClientConnection(for: client.id, cdpPort: 9222)
        await proxy.receive(.text(#"{"id":1}"#), from: UUID())
        await proxy.removeClient(id: UUID(), reason: "stale")
        await proxy.receive(.text(#"{"id":2}"#), from: client.id)
        await proxy.shutdown()

        let harness = ChromeConnectorHarness()
        let forwardingProxy = CDPProxy(
            logger: logger(),
            discoverer: { _ in "ws://client-failure" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 0,
            sleep: { _ in throw CancellationError() },
            secretInjector: SecretInjector(secrets: [])
        )
        let brokenClient = ClientHandle(
            send: { _ in throw URLError(.cannotWriteToFile) },
            close: { _, _ in }
        )
        try await forwardingProxy.preWarm(cdpPort: 9222)
        await forwardingProxy.addClient(brokenClient)
        await forwardingProxy.prepareClientConnection(for: brokenClient.id, cdpPort: 9222)
        await harness.emitText(#"{"id":7,"result":{}}"#)
        await harness.emitText(#"{"id":8,"result":{}}"#)
        await harness.emitEvent(.error("socket failed"))
        await forwardingProxy.shutdown()
    }

    func testPreparationFailureAndDisconnectWithoutKnownPortCloseCleanly() async throws {
        let failedClient = ClientRecorder()
        let failingProxy = CDPProxy(
            logger: logger(),
            discoverer: { _ in throw CDPProxyError.discoveryFailed("fixture unavailable") }
        )
        await failingProxy.addClient(failedClient.handle)
        await failingProxy.receive(.text(#"{"id":1}"#), from: failedClient.handle.id)
        await failingProxy.prepareClientConnection(for: failedClient.handle.id, cdpPort: 9222)
        XCTAssertEqual(failedClient.closeCodesSnapshot(), [.goingAway])
        XCTAssertEqual(failedClient.closeReasonsSnapshot(), ["Failed to connect to Chrome CDP"])

        let harness = ChromeConnectorHarness()
        let noPortProxy = CDPProxy(
            logger: logger(),
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 0
        )
        try await noPortProxy.ensureChromeConnection(url: "ws://fixture/no-port")
        await harness.emitEvent(.closed("intentional"))
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(harness.connectCountSnapshot(), 1)
        await noPortProxy.shutdown()
    }

    func testChromeTerminationReportsOverflowAndTransportFailure() async {
        let overflowEvents = ChromeSocketEventRecorder()
        let overflowPump = ChromeInboundMessagePump(maxBufferedMessages: 1)
        let overflowTask = Task {
            await CDPProxy.runChromeMessagePump(overflowPump) { _ in }
        }
        await CDPProxy.handleChromeSocketTermination(
            messagePump: overflowPump,
            messagePumpTask: overflowTask,
            result: .success(()),
            closeDescription: "unused",
            overflowDescription: "buffer overflow",
            onEvent: { await overflowEvents.record($0) }
        )
        let recordedOverflowEvents = await overflowEvents.snapshot()
        XCTAssertEqual(recordedOverflowEvents, ["error: buffer overflow"])

        let failureEvents = ChromeSocketEventRecorder()
        let failurePump = ChromeInboundMessagePump(maxBufferedMessages: 1)
        let failureTask = Task {
            await CDPProxy.runChromeMessagePump(failurePump) { _ in }
        }
        await CDPProxy.handleChromeSocketTermination(
            messagePump: failurePump,
            messagePumpTask: failureTask,
            result: .failure(URLError(.networkConnectionLost)),
            closeDescription: "unused",
            overflowDescription: nil,
            onEvent: { await failureEvents.record($0) }
        )
        let recordedFailureEvents = await failureEvents.snapshot()
        XCTAssertTrue(recordedFailureEvents.contains { $0.contains("error: Error Domain=NSURLErrorDomain") })
    }

    func testTrackingMalformedDetachAndValueHelpers() async throws {
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: logger(),
            discoverer: { port in "ws://127.0.0.1:\(port)/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            secretInjector: SecretInjector(secrets: [])
        )
        let discoveredURL = try await proxy.discoverCDPUrl(port: 9222)
        XCTAssertEqual(discoveredURL, "ws://127.0.0.1:9222/devtools/browser/test")
        try await proxy.preWarm(cdpPort: 9222)
        await harness.emitText("not-json")
        await harness.emitText(#"{"params":{}}"#)
        await harness.emitText(#"{"method":"Unknown.event","params":{}}"#)
        await harness.emitText(#"{"method":"Target.attachedToTarget","params":{}}"#)
        await harness.emitText(#"{"method":"Target.targetInfoChanged","params":{}}"#)
        await harness.emitText(#"{"method":"Page.frameNavigated","params":{}}"#)
        await harness.emitText(
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","url":"https:
        )
        await harness.emitText(
            #"{"method":"Page.frameNavigated","sessionId":"S1","params":{"frame":{"id":"root","url":"https:
        )
        let rootsBeforeDetach = await proxy.sessionRootFrameSnapshot()
        XCTAssertEqual(rootsBeforeDetach, ["S1": "root"])
        await harness.emitText(#"{"method":"Target.detachedFromTarget","params":{"sessionId":"S1"}}"#)
        let urlsAfterDetach = await proxy.sessionURLSnapshot()
        let rootsAfterDetach = await proxy.sessionRootFrameSnapshot()
        XCTAssertTrue(urlsAfterDetach.isEmpty)
        XCTAssertTrue(rootsAfterDetach.isEmpty)

        let bytes = ByteBuffer(bytes: [1, 2, 3])
        XCTAssertEqual(ProxyMessage(.text("hello")).preview, "hello")
        XCTAssertEqual(ProxyMessage(.binary(bytes)).preview, "<binary 3 bytes>")
        XCTAssertNil(CDPProxy.chromeFrameDropReason(.binary(bytes)))
        XCTAssertEqual(CDPProxyError.discoveryFailed("no CDP").localizedDescription, "no CDP")
        let injector = SecretInjector(secrets: [
            .init(
                name: "TOKEN",
                realValue: "real-token-abcdefghijklmnop",
                maskedValue: "masked-token-abcdefghijklmnop",
                domains: ["example.test"]
            )
        ])
        XCTAssertNil(CDPProxy.unmaskClientFrame(text: "not-json", injector: injector) { _ in nil })
        XCTAssertNil(
            CDPProxy.unmaskClientFrame(
                text: #"{"sessionId":"S1","method":"Runtime.evaluate"}"#,
                injector: injector,
                urlForSession: { _ in "https://example.test/" }
            ))
        XCTAssertNil(
            CDPProxy.unmaskClientFrame(
                text: #"{"sessionId":"S1","method":"Runtime.callFunctionOn","params":{}}"#,
                injector: injector,
                urlForSession: { _ in "https://example.test/" }
            ))
        await proxy.shutdown()
    }

    private func makeChromeApp(port: Int) -> some ApplicationProtocol {
        let router = Router()
        router.get("/health") { _, _ in "ok" }
        let wsRouter = Router(context: BasicWebSocketRequestContext.self)
        wsRouter.ws("/devtools/browser/test") { _, _ in
            .upgrade()
        } onUpgrade: { inbound, outbound, _ in
            for try await message in inbound.messages(maxSize: 1024 * 1024) {
                guard case .text = message else { continue }
                try await outbound.write(.text(#"{"id":1,"result":{}}"#))
                try await outbound.write(.binary(ByteBuffer(bytes: [1, 2, 3])))
                try await outbound.write(
                    .text(#"{"method":"Network.webSocketFrameReceived","params":{}}"#)
                )
                for _ in 0..<32 {
                    try await outbound.write(
                        .text(#"{"method":"Network.webSocketFrameReceived","params":{}}"#)
                    )
                }
            }
        }
        return Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: wsRouter,
                configuration: .init(maxFrameSize: 1024 * 1024)
            ),
            configuration: .init(address: .hostname("127.0.0.1", port: port))
        )
    }

    private func makeProxyApp(port: Int, proxy: CDPProxy) async -> some ApplicationProtocol {
        let router = Router()
        router.get("/health") { _, _ in "ok" }
        let wsRouter = Router(context: BasicWebSocketRequestContext.self)
        await proxy.install(on: wsRouter, cdpPort: port)
        return Application(
            router: router,
            server: .http1WebSocketUpgrade(
                webSocketRouter: wsRouter,
                configuration: .init(maxFrameSize: 1024 * 1024)
            ),
            configuration: .init(address: .hostname("127.0.0.1", port: port))
        )
    }

    private func waitForServer(port: Int) async throws {
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if let (_, response) = try? await URLSession.shared.data(from: url),
                (response as? HTTPURLResponse)?.statusCode == 200
            {
                return
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("mock Chrome WebSocket did not start")
    }
}

private final class LockedInt: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0
    func increment() { lock.withLock { stored += 1 } }
    var value: Int { lock.withLock { stored } }
}
