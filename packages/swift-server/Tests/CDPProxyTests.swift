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

    func testDropsNetworkWebSocketFrameFeedbackLoopEvents() async throws {
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            }
        )
        let client = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(client.handle)

        // The self-amplifying loop events must NOT be forwarded to the client.
        await harness.emitText("{\"method\":\"Network.webSocketFrameReceived\",\"params\":{}}")
        await harness.emitText("{\"method\":\"Network.webSocketFrameSent\",\"params\":{}}")
        // A normal CDP frame still flows through.
        await harness.emitText("{\"id\":7,\"result\":{}}")

        XCTAssertEqual(client.sentTextsSnapshot(), ["{\"id\":7,\"result\":{}}"])
    }

    func testChromeFrameDropReasonClassifiesFrames() {
        XCTAssertNotNil(
            CDPProxy.chromeFrameDropReason(
                .text("{\"method\":\"Network.webSocketFrameReceived\",\"params\":{}}")
            )
        )
        XCTAssertNotNil(
            CDPProxy.chromeFrameDropReason(
                .text("{\"method\":\"Network.webSocketFrameSent\",\"params\":{}}")
            )
        )
        // Normal CDP frames are forwarded (no drop reason).
        XCTAssertNil(
            CDPProxy.chromeFrameDropReason(
                .text("{\"method\":\"Target.attachedToTarget\",\"params\":{}}")
            )
        )
        XCTAssertNil(CDPProxy.chromeFrameDropReason(.text("{\"id\":1,\"result\":{}}")))
        // Frames over the hard cap are dropped regardless of method.
        let oversized = String(repeating: "a", count: CDPProxy.cdpProxyHardFrameCap + 1)
        XCTAssertNotNil(CDPProxy.chromeFrameDropReason(.text(oversized)))
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

        XCTAssertEqual(
            harness.connectedURLsSnapshot(),
            [
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
        let attached =
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/path"}}}"#
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

        let attached =
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://evil.example.org/"}}}"#
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

        let attached =
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/"}}}"#
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

        let attached =
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/"}}}"#
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

        let attached =
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/"}}}"#
        await harness.emitText(attached)

        let masked = Self.inDomainSecret.maskedValue
        let argsJSON =
            "[{\"value\":\"\(masked)\"},{\"value\":42},{\"objectId\":\"obj-1\"},"
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

        await harness.emitText(
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/"}}}"#)
        // Subframe navigation should NOT update the tracked URL.
        await harness.emitText(
            #"{"method":"Page.frameNavigated","params":{"frame":{"id":"sub-frame","parentId":"main-frame","url":"https://evil.example.org/"}},"sessionId":"S1"}"#
        )
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

        await harness.emitText(
            #"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"targetId":"T1","type":"page","url":"https://example.com/old"}}}"#)
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

    // MARK: - /cdp upgrade gate (RFC 6455 + BridgeSecurity wiring)
    //
    // Cross-runtime parity with node-server's `validateBridgeUpgrade` tests
    // in `packages/node-server/tests/bridge-security.test.ts`. The thin
    // standalone + thin-Electron modes both depend on the same upgrade
    // contract: same-origin Chrome runs unchanged (bridgeToken == nil) and
    // hosted-leader runs require the per-process subprotocol token to be
    // echoed back so the browser keeps the socket open.

    func testEvaluateBridgeUpgradeLegacyModeAllowsAllUpgrades() {
        let decision = CDPProxy.evaluateBridgeUpgrade(
            origin: "https://untrusted.example.com",
            subprotocolHeader: nil,
            bridgeToken: nil
        )
        guard case .upgrade(let headers) = decision else {
            XCTFail("Expected .upgrade for legacy (nil token) mode, got \(decision)")
            return
        }
        // Legacy upgrade returns empty headers (no subprotocol echo).
        XCTAssertTrue(headers.isEmpty)
    }

    func testEvaluateBridgeUpgradeAcceptsMatchingSubprotocolAndEchoesIt() {
        let token = "test-token-123"
        let subprotocol = "slicc.bridge.v1.\(token)"
        let decision = CDPProxy.evaluateBridgeUpgrade(
            origin: "https://www.sliccy.ai",
            subprotocolHeader: subprotocol,
            bridgeToken: token
        )
        guard case .upgrade(let headers) = decision else {
            XCTFail("Expected .upgrade for matching token, got \(decision)")
            return
        }
        // RFC 6455 §1.9: the selected subprotocol MUST be echoed back in
        // the 101 response, otherwise the client closes the socket.
        XCTAssertEqual(headers[.secWebSocketProtocol], subprotocol)
    }

    func testEvaluateBridgeUpgradeRejectsMissingSubprotocolHeader() {
        var rejectionReason: String?
        let decision = CDPProxy.evaluateBridgeUpgrade(
            origin: "https://www.sliccy.ai",
            subprotocolHeader: nil,
            bridgeToken: "test-token-123",
            onReject: { rejectionReason = $0 }
        )
        guard case .dontUpgrade = decision else {
            XCTFail("Expected .dontUpgrade for missing subprotocol, got \(decision)")
            return
        }
        XCTAssertEqual(rejectionReason, BridgeSecurity.RejectionReason.subprotocolMissingOrMismatched.rawValue)
    }

    func testEvaluateBridgeUpgradeRejectsMismatchedSubprotocolToken() {
        var rejectionReason: String?
        let decision = CDPProxy.evaluateBridgeUpgrade(
            origin: "https://www.sliccy.ai",
            subprotocolHeader: "slicc.bridge.v1.wrong-token",
            bridgeToken: "test-token-123",
            onReject: { rejectionReason = $0 }
        )
        guard case .dontUpgrade = decision else {
            XCTFail("Expected .dontUpgrade for wrong token, got \(decision)")
            return
        }
        XCTAssertEqual(rejectionReason, BridgeSecurity.RejectionReason.subprotocolMissingOrMismatched.rawValue)
    }

    func testEvaluateBridgeUpgradeRejectsDisallowedOriginEvenWithCorrectToken() {
        var rejectionReason: String?
        let token = "test-token-123"
        let decision = CDPProxy.evaluateBridgeUpgrade(
            origin: "https://evil.example.com",
            subprotocolHeader: "slicc.bridge.v1.\(token)",
            bridgeToken: token,
            onReject: { rejectionReason = $0 }
        )
        guard case .dontUpgrade = decision else {
            XCTFail("Expected .dontUpgrade for disallowed origin, got \(decision)")
            return
        }
        XCTAssertEqual(rejectionReason, BridgeSecurity.RejectionReason.originNotAllowed.rawValue)
    }
}
