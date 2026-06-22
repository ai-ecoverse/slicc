import Logging
import NIOCore
import NIOWebSocket
import XCTest
@testable import slicc_server

final class CDPProxyTests: XCTestCase {
    func testPreWarmDiscoversAndReusesChromeConnection() async throws {
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { port in
                XCTAssertEqual(port, 9222)
                return "ws://127.0.0.1:9222/devtools/browser/test"
            },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )

        try await proxy.preWarm(cdpPort: 9222)
        try await proxy.preWarm(cdpPort: 9222)

        XCTAssertEqual(harness.connectCountSnapshot(), 1)
        XCTAssertEqual(harness.connectedURLsSnapshot(), ["ws://127.0.0.1:9222/devtools/browser/test"])
    }

    func testBuffersMessagesWhileChromeConnectsAndFlushesAfterOpen() async {
        let harness = ChromeConnectorHarness(waitForExplicitResume: true)
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let client = ClientRecorder()

        await proxy.addClient(client.handle)
        let prepareTask = Task {
            await proxy.prepareClientConnection(for: client.handle.id, cdpPort: 9222)
        }

        await proxy.receive(.text("{\"id\":1}"), from: client.handle.id)
        XCTAssertEqual(harness.sentTextsSnapshot(), [])

        await harness.resumePendingConnection()
        await prepareTask.value

        XCTAssertEqual(harness.sentTextsSnapshot(), ["{\"id\":1}"])
    }

    func testNewClientClosesPreviousAndReceivesChromeMessages() async throws {
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let firstClient = ClientRecorder()
        let secondClient = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(firstClient.handle)
        await proxy.addClient(secondClient.handle)
        await harness.emitText("{\"id\":7}")

        XCTAssertEqual(firstClient.closeReasonsSnapshot(), ["Replaced by newer /cdp client"])
        // Close with the supersede code (4001), NOT .goingAway (1001), so the
        // webapp CDPClient latches "superseded" and stops re-dialing.
        XCTAssertEqual(firstClient.closeCodesSnapshot(), [.unknown(CDPProxy.supersededCloseCode)])
        XCTAssertEqual(firstClient.sentTextsSnapshot(), [])
        XCTAssertEqual(secondClient.sentTextsSnapshot(), ["{\"id\":7}"])
    }

    func testChromeCloseReconnectsAndFlushesBufferedMessages() async throws {
        let reconnectGate = AsyncGate()
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 0,
            sleep: { _ in await reconnectGate.wait() }
        )
        let client = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(client.handle)

        await harness.emitEvent(.closed("code=Optional(messageTooLarge)"))
        await proxy.receive(.text("{\"id\":24,\"method\":\"Target.getTargets\"}"), from: client.handle.id)

        XCTAssertEqual(harness.connectCountSnapshot(), 1)
        XCTAssertEqual(harness.sentTextsSnapshot(), [])

        await reconnectGate.open()
        for _ in 0..<200 {
            if harness.connectCountSnapshot() >= 2 {
                break
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertEqual(harness.connectCountSnapshot(), 2)
        XCTAssertEqual(harness.sentTextsSnapshot(), ["{\"id\":24,\"method\":\"Target.getTargets\"}"])
    }

    func testChromeReconnectRediscoversCDPURL() async throws {
        let reconnectGate = AsyncGate()
        let discoverer = DiscovererHarness(urls: [
            "ws://127.0.0.1:9222/devtools/browser/first",
            "ws://127.0.0.1:9222/devtools/browser/second",
        ])
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { port in
                await discoverer.discover(port: port)
            },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 0,
            sleep: { _ in await reconnectGate.wait() }
        )
        let client = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(client.handle)

        await harness.emitEvent(.closed("code=Optional(normalClosure)"))
        await reconnectGate.open()

        for _ in 0..<200 {
            if harness.connectCountSnapshot() >= 2 {
                break
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertEqual(harness.connectedURLsSnapshot(), [
            "ws://127.0.0.1:9222/devtools/browser/first",
            "ws://127.0.0.1:9222/devtools/browser/second",
        ])
        let discovererCallCount = await discoverer.callCount()
        XCTAssertEqual(discovererCallCount, 2)
    }

    func testBufferedMessagesDropOldestWhenBufferReachesLimit() async {
        let harness = ChromeConnectorHarness(waitForExplicitResume: true)
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let client = ClientRecorder()

        await proxy.addClient(client.handle)
        let prepareTask = Task {
            await proxy.prepareClientConnection(for: client.handle.id, cdpPort: 9222)
        }

        for id in 1...1_001 {
            await proxy.receive(.text("{\"id\":\(id)}"), from: client.handle.id)
        }

        await harness.resumePendingConnection()
        await prepareTask.value

        let sentTexts = harness.sentTextsSnapshot()
        XCTAssertEqual(sentTexts.count, 1_000)
        XCTAssertEqual(sentTexts.first, "{\"id\":2}")
        XCTAssertEqual(sentTexts.last, "{\"id\":1001}")
    }

    func testChromeMessagePumpPreservesInboundMessageOrder() async {
        let messagePump = ChromeInboundMessagePump(maxBufferedMessages: 4)
        let recorder = PumpMessageRecorder()

        let pumpTask = Task {
            await CDPProxy.runChromeMessagePump(messagePump) { message in
                await recorder.record(message)
            }
        }

        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":1}")), .enqueued)
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":2}")), .enqueued)
        messagePump.finish()

        _ = await pumpTask.value

        let receivedTexts = await recorder.snapshot()
        XCTAssertEqual(receivedTexts, ["{\"id\":1}", "{\"id\":2}"])
    }

    func testChromeMessagePumpOverflowStopsAcceptingNewFramesAndDrainsBufferedFrames() async {
        let messagePump = ChromeInboundMessagePump(maxBufferedMessages: 2)
        let recorder = PumpMessageRecorder()

        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":1}")), .enqueued)
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":2}")), .enqueued)
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":3}")), .overflow)
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":4}")), .terminated)

        await CDPProxy.runChromeMessagePump(messagePump) { message in
            await recorder.record(message)
        }

        let receivedTexts = await recorder.snapshot()
        XCTAssertEqual(receivedTexts, ["{\"id\":1}", "{\"id\":2}"])
    }

    func testChromeSocketTerminationWaitsForPumpDrainBeforeReportingClose() async {
        let messagePump = ChromeInboundMessagePump(maxBufferedMessages: 4)
        let recorder = BlockingPumpMessageRecorder()
        let closeEvents = ChromeSocketEventRecorder()

        let pumpTask = Task {
            await CDPProxy.runChromeMessagePump(messagePump) { message in
                await recorder.record(message)
            }
        }

        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":1}")), .enqueued)
        await recorder.waitForFirstMessage()
        XCTAssertEqual(messagePump.enqueue(.text("{\"id\":2}")), .enqueued)

        let terminationTask = Task {
            await CDPProxy.handleChromeSocketTermination(
                messagePump: messagePump,
                messagePumpTask: pumpTask,
                result: Result<Void, Error>.success(()),
                closeDescription: "code=nil",
                overflowDescription: nil,
                onEvent: { event in
                    await closeEvents.record(event)
                }
            )
        }

        let initialEvents = await closeEvents.snapshot()
        XCTAssertEqual(initialEvents, [])

        await recorder.releaseFirstMessage()
        _ = await terminationTask.value

        let recordedMessages = await recorder.snapshot()
        let finalEvents = await closeEvents.snapshot()
        XCTAssertEqual(recordedMessages, ["{\"id\":1}", "{\"id\":2}"])
        XCTAssertEqual(finalEvents, ["closed: code=nil"])
    }

    // MARK: - Client→Chrome unmask + session→URL tracking (Wave A Task 4)

    private func makeProxyWithInjector(
        harness: ChromeConnectorHarness,
        secrets: [SecretInjector.LoadedSecret]
    ) -> (CDPProxy, SecretInjector) {
        let injector = SecretInjector(secrets: secrets)
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            secretInjector: injector
        )
        return (proxy, injector)
    }

    /// `addClient` seeds an empty `messageBuffer` so subsequent `receive()`
    /// calls buffer instead of forwarding directly; production drains the
    /// buffer by calling `prepareClientConnection` right after `addClient`.
    /// Tests mirror that ordering so frames flow through to Chrome.
    private func setupClientWithFlush(
        proxy: CDPProxy,
        client: ClientRecorder
    ) async {
        await proxy.addClient(client.handle)
        await proxy.prepareClientConnection(for: client.handle.id, cdpPort: 9222)
    }

    private static let inDomainSecret = SecretInjector.LoadedSecret(
        name: "API_KEY",
        realValue: "sk-realValue123",
        maskedValue: mask(sessionId: "session-fixed", secretName: "API_KEY", realValue: "sk-realValue123"),
        domains: ["example.com"]
    )

    func testClientFrameUnmaskRuntimeEvaluateInDomain() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        // Seed session→URL via a sniffed Target.attachedToTarget event.
        let attached = #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/path"}}}"#
        await harness.emitText(attached)

        let masked = Self.inDomainSecret.maskedValue
        let outbound = #"{"id":42,"method":"Runtime.evaluate","params":{"expression":"submit(\#(masked))","returnByValue":true},"sessionId":"S1"}"#
        await proxy.receive(.text(outbound), from: client.handle.id)

        let sent = harness.sentTextsSnapshot()
        XCTAssertEqual(sent.count, 1)
        let parsed = try JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as? [String: Any]
        XCTAssertEqual(parsed?["id"] as? Int, 42)
        XCTAssertEqual(parsed?["sessionId"] as? String, "S1")
        XCTAssertEqual(parsed?["method"] as? String, "Runtime.evaluate")
        let params = parsed?["params"] as? [String: Any]
        XCTAssertEqual(params?["expression"] as? String, "submit(sk-realValue123)")
        XCTAssertEqual(params?["returnByValue"] as? Bool, true)
    }

    func testClientFrameOutOfDomainPassesThroughMasked() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        let attached = #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://evil.example.org/"}}}"#
        await harness.emitText(attached)

        let masked = Self.inDomainSecret.maskedValue
        let outbound = #"{"id":1,"method":"Runtime.evaluate","params":{"expression":"\#(masked)"},"sessionId":"S1"}"#
        await proxy.receive(.text(outbound), from: client.handle.id)

        XCTAssertEqual(harness.sentTextsSnapshot(), [outbound])
    }

    func testClientFrameFailsClosedWhenSessionURLUnresolved() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        // No Target.attachedToTarget emitted → fail-closed (forward verbatim).
        let masked = Self.inDomainSecret.maskedValue
        let outbound = #"{"id":1,"method":"Runtime.evaluate","params":{"expression":"\#(masked)"},"sessionId":"unknown"}"#
        await proxy.receive(.text(outbound), from: client.handle.id)

        XCTAssertEqual(harness.sentTextsSnapshot(), [outbound])
    }

    func testClientFrameNonTargetMethodIsForwardedVerbatim() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        let attached = #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/"}}}"#
        await harness.emitText(attached)

        let masked = Self.inDomainSecret.maskedValue
        let outbound = #"{"id":1,"method":"Input.dispatchKeyEvent","params":{"type":"char","text":"\#(masked)"},"sessionId":"S1"}"#
        await proxy.receive(.text(outbound), from: client.handle.id)

        XCTAssertEqual(harness.sentTextsSnapshot(), [outbound])
    }

    func testClientBinaryFrameForwardedUntouched() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        var buffer = ByteBuffer()
        buffer.writeBytes([0x01, 0x02, 0x03])
        await proxy.receive(.binary(buffer), from: client.handle.id)
        XCTAssertEqual(harness.sentTextsSnapshot(), ["<binary 3>"])
    }

    func testInsertTextInDomainUnmaskFlow() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        let attached = #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/"}}}"#
        await harness.emitText(attached)

        let masked = Self.inDomainSecret.maskedValue
        let outbound = #"{"id":7,"method":"Input.insertText","params":{"text":"\#(masked)"},"sessionId":"S1"}"#
        await proxy.receive(.text(outbound), from: client.handle.id)

        let sent = harness.sentTextsSnapshot()
        XCTAssertEqual(sent.count, 1)
        let parsed = try JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as? [String: Any]
        let params = parsed?["params"] as? [String: Any]
        XCTAssertEqual(params?["text"] as? String, "sk-realValue123")
    }

    func testCallFunctionOnUnmaskOnlyStringArguments() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        let attached = #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/"}}}"#
        await harness.emitText(attached)

        let masked = Self.inDomainSecret.maskedValue
        let argsJSON = "[{\"value\":\"\(masked)\"},{\"value\":42},{\"objectId\":\"obj-1\"},"
            + "{\"value\":\"prefix \(masked) suffix\"}]"
        let paramsJSON = "{\"functionDeclaration\":\"function(v){this.value=v}\"," + "\"arguments\":\(argsJSON)}"
        let outbound = "{\"id\":3,\"method\":\"Runtime.callFunctionOn\",\"params\":\(paramsJSON),\"sessionId\":\"S1\"}"
        await proxy.receive(.text(outbound), from: client.handle.id)

        let sent = harness.sentTextsSnapshot()
        XCTAssertEqual(sent.count, 1)
        let parsed = try JSONSerialization.jsonObject(with: Data(sent[0].utf8)) as? [String: Any]
        let params = parsed?["params"] as? [String: Any]
        let args = params?["arguments"] as? [[String: Any]]
        XCTAssertEqual(args?[0]["value"] as? String, "sk-realValue123")
        XCTAssertEqual(args?[1]["value"] as? Int, 42)
        XCTAssertEqual(args?[2]["objectId"] as? String, "obj-1")
        XCTAssertEqual(args?[3]["value"] as? String, "prefix sk-realValue123 suffix")
    }

    func testSessionURLTrackerPageFrameNavigatedUpdatesMainFrameOnly() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        await harness.emitText(#"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/"}}}"#)
        // Subframe navigation should NOT update the tracked URL.
        await harness.emitText(#"{"method":"Page.frameNavigated","params":{"frame":{"id":"sub-frame","parentId":"main-frame","url":"https://evil.example.org/"}},"sessionId":"S1"}"#)
        let urlsAfterSub = await proxy.sessionURLSnapshot()
        XCTAssertEqual(urlsAfterSub["S1"], "https://example.com/")

        // Main-frame navigation (no parentId) updates the URL.
        await harness.emitText(#"{"method":"Page.frameNavigated","params":{"frame":{"id":"main-frame","url":"https://example.com/new"}},"sessionId":"S1"}"#)
        let urlsAfterMain = await proxy.sessionURLSnapshot()
        XCTAssertEqual(urlsAfterMain["S1"], "https://example.com/new")
    }

    func testSessionURLTrackerTargetInfoChangedUpdatesURL() async throws {
        let harness = ChromeConnectorHarness()
        let (proxy, _) = self.makeProxyWithInjector(harness: harness, secrets: [Self.inDomainSecret])
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        await harness.emitText(#"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/old"}}}"#)
        await harness.emitText(#"{"method":"Target.targetInfoChanged","params":{"targetInfo":{"targetId":"T1","url":"https://example.com/new"}}}"#)
        let urls = await proxy.sessionURLSnapshot()
        XCTAssertEqual(urls["S1"], "https://example.com/new")
    }

    func testNoInjectorIsNoOpPassthrough() async throws {
        let harness = ChromeConnectorHarness()
        // No SecretInjector passed → must be a complete passthrough.
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let client = ClientRecorder()
        await self.setupClientWithFlush(proxy: proxy, client: client)

        let outbound = #"{"id":1,"method":"Runtime.evaluate","params":{"expression":"anything"},"sessionId":"S1"}"#
        await proxy.receive(.text(outbound), from: client.handle.id)
        XCTAssertEqual(harness.sentTextsSnapshot(), [outbound])
    }
}

private final class ClientRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var sentTexts: [String] = []
    private var closeReasons: [String] = []
    private var closeCodes: [WebSocketErrorCode] = []

    lazy var handle: ClientHandle = ClientHandle(
        send: { [weak self] message in
            guard let self else { return }
            switch message {
            case .text(let text):
                self.recordSentText(text)
            case .binary:
                XCTFail("Expected text-only message in test client")
            }
        },
        close: { [weak self] code, reason in
            self?.recordClose(code: code, reason: reason)
        }
    )

    func sentTextsSnapshot() -> [String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.sentTexts
    }

    func closeReasonsSnapshot() -> [String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.closeReasons
    }

    func closeCodesSnapshot() -> [WebSocketErrorCode] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.closeCodes
    }

    private func recordSentText(_ text: String) {
        self.lock.lock()
        self.sentTexts.append(text)
        self.lock.unlock()
    }

    private func recordClose(code: WebSocketErrorCode, reason: String?) {
        self.lock.lock()
        self.closeCodes.append(code)
        self.closeReasons.append(reason ?? "")
        self.lock.unlock()
    }
}

private final class ChromeConnectorHarness: @unchecked Sendable {
    private let gate: AsyncGate?
    private let state = HarnessState()

    init(waitForExplicitResume: Bool = false) {
        self.gate = waitForExplicitResume ? AsyncGate() : nil
    }

    func connect(
        url: String,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) async throws -> ChromeSocketHandle {
        self.state.recordConnect(url: url, onMessage: onMessage, onEvent: onEvent)
        self.state.setOpen(true)

        if let gate {
            await gate.wait()
        }

        return ChromeSocketHandle(
            send: { [weak self] message in
                self?.recordSend(message)
            },
            close: { [weak self] in
                self?.setOpen(false)
            },
            isOpen: { [weak self] in
                self?.isOpenSnapshot() ?? false
            }
        )
    }

    func resumePendingConnection() async {
        await self.gate?.open()
    }

    func emitText(_ text: String) async {
        let callback = self.messageCallbackSnapshot()
        await callback?(.text(text))
    }

    func emitEvent(_ event: ChromeSocketEvent) async {
        let callback = self.eventCallbackSnapshot()
        await callback?(event)
    }

    func connectCountSnapshot() -> Int {
        self.state.connectCountSnapshot()
    }

    func connectedURLsSnapshot() -> [String] {
        self.state.connectedURLsSnapshot()
    }

    func sentTextsSnapshot() -> [String] {
        self.state.sentTextsSnapshot()
    }

    private func recordSend(_ message: ProxyMessage) {
        self.state.recordSend(message)
    }

    private func messageCallbackSnapshot() -> (@Sendable (ProxyMessage) async -> Void)? {
        self.state.messageCallbackSnapshot()
    }

    private func eventCallbackSnapshot() -> (@Sendable (ChromeSocketEvent) async -> Void)? {
        self.state.eventCallbackSnapshot()
    }

    private func isOpenSnapshot() -> Bool {
        self.state.isOpenSnapshot()
    }

    private func setOpen(_ isOpen: Bool) {
        self.state.setOpen(isOpen)
    }
}

private final class HarnessState: @unchecked Sendable {
    private let lock = NSLock()
    private var connectCount = 0
    private var connectedURLs: [String] = []
    private var sentTexts: [String] = []
    private var onMessage: (@Sendable (ProxyMessage) async -> Void)?
    private var onEvent: (@Sendable (ChromeSocketEvent) async -> Void)?
    private var isOpen = true

    func recordConnect(
        url: String,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) {
        self.lock.lock()
        self.connectCount += 1
        self.connectedURLs.append(url)
        self.onMessage = onMessage
        self.onEvent = onEvent
        self.lock.unlock()
    }

    func recordSend(_ message: ProxyMessage) {
        self.lock.lock()
        defer { self.lock.unlock() }
        switch message {
        case .text(let text):
            self.sentTexts.append(text)
        case .binary(let buffer):
            self.sentTexts.append("<binary \(buffer.readableBytes)>")
        }
    }

    func connectCountSnapshot() -> Int {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.connectCount
    }

    func connectedURLsSnapshot() -> [String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.connectedURLs
    }

    func sentTextsSnapshot() -> [String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.sentTexts
    }

    func messageCallbackSnapshot() -> (@Sendable (ProxyMessage) async -> Void)? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.onMessage
    }

    func eventCallbackSnapshot() -> (@Sendable (ChromeSocketEvent) async -> Void)? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.onEvent
    }

    func isOpenSnapshot() -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.isOpen
    }

    func setOpen(_ isOpen: Bool) {
        self.lock.lock()
        self.isOpen = isOpen
        self.lock.unlock()
    }
}

private actor DiscovererHarness {
    private let urls: [String]
    private var nextIndex = 0

    init(urls: [String]) {
        self.urls = urls
    }

    func discover(port: Int) -> String {
        XCTAssertEqual(port, 9222)
        let index = min(self.nextIndex, self.urls.count - 1)
        self.nextIndex += 1
        return self.urls[index]
    }

    func callCount() -> Int {
        self.nextIndex
    }
}

private actor AsyncGate {
    private var isOpen = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !self.isOpen else {
            return
        }

        await withCheckedContinuation { continuation in
            self.continuations.append(continuation)
        }
    }

    func open() {
        guard !self.isOpen else {
            return
        }

        self.isOpen = true
        let pendingContinuations = self.continuations
        self.continuations.removeAll()
        for continuation in pendingContinuations {
            continuation.resume()
        }
    }
}

private actor PumpMessageRecorder {
    private var recordedTexts: [String] = []

    func record(_ message: ProxyMessage) {
        switch message {
        case .text(let text):
            self.recordedTexts.append(text)
        case .binary(let buffer):
            self.recordedTexts.append("<binary \(buffer.readableBytes)>")
        }
    }

    func snapshot() -> [String] {
        self.recordedTexts
    }
}

private actor BlockingPumpMessageRecorder {
    private let firstMessageGate = AsyncGate()
    private let releaseGate = AsyncGate()
    private var recordedTexts: [String] = []
    private var shouldBlockFirstMessage = true

    func record(_ message: ProxyMessage) async {
        if self.shouldBlockFirstMessage {
            self.shouldBlockFirstMessage = false
            await self.firstMessageGate.open()
            await self.releaseGate.wait()
        }

        switch message {
        case .text(let text):
            self.recordedTexts.append(text)
        case .binary(let buffer):
            self.recordedTexts.append("<binary \(buffer.readableBytes)>")
        }
    }

    func waitForFirstMessage() async {
        await self.firstMessageGate.wait()
    }

    func releaseFirstMessage() async {
        await self.releaseGate.open()
    }

    func snapshot() -> [String] {
        self.recordedTexts
    }
}

private actor ChromeSocketEventRecorder {
    private var events: [String] = []

    func record(_ event: ChromeSocketEvent) {
        switch event {
        case .closed(let description):
            self.events.append("closed: \(description)")
        case .error(let description):
            self.events.append("error: \(description)")
        }
    }

    func snapshot() -> [String] {
        self.events
    }
}
