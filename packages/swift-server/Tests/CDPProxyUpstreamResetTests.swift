import Logging
import NIOCore
import NIOWebSocket
import XCTest

@testable import slicc_server

/// Chrome-leg reset signalling (`upstreamResetCloseCode`) and the inbound
/// overflow attribution that explains why the leg died — the proxy half of
/// issue #2417. Shared doubles live in `CDPProxyTestSupport.swift`.
final class CDPProxyUpstreamResetTests: XCTestCase {
    func testChromeReconnectClosesClientWithUpstreamResetOnlyAfterChromeIsBack() async throws {
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

        // The client must survive the drop: closing it before the Chrome leg is
        // back would make the reconnecting client race the reconnect.
        XCTAssertEqual(client.closeCodesSnapshot(), [])

        harness.holdConnectsUntilReleased()
        await reconnectGate.open()
        try await self.waitUntil("the reconnect to reach Chrome") {
            harness.connectCountSnapshot() >= 2
        }
        // Still mid-connect: the client is not signalled while the Chrome leg
        // is only half-way back.
        XCTAssertEqual(client.closeCodesSnapshot(), [])

        await harness.releaseHeldConnects()
        try await self.waitUntil("the client to be closed after the reconnect") {
            !client.closeCodesSnapshot().isEmpty
        }

        // 4002 (not 4001): the webapp must reconnect and reset its sessions,
        // rather than latch "superseded" and stop re-dialing.
        XCTAssertEqual(client.closeCodesSnapshot(), [.unknown(CDPProxy.upstreamResetCloseCode)])
        XCTAssertEqual(client.closeReasonsSnapshot(), ["upstream-reset"])
        // Buffered frames are flushed by the reconnect before the client is cut
        // loose, so nothing queued during the outage is lost.
        XCTAssertEqual(harness.connectCountSnapshot(), 2)
        XCTAssertEqual(harness.sentTextsSnapshot(), ["{\"id\":24,\"method\":\"Target.getTargets\"}"])
    }

    func testChromeReconnectClosesClientWithUpstreamResetAfterThirdFailedAttempt() async throws {
        // One sleep permit per reconnect attempt, so the loop can be stepped
        // attempt by attempt.
        let attemptGate = StepGate()
        let harness = ChromeConnectorHarness()
        let proxy = CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 0,
            sleep: { _ in await attemptGate.wait() }
        )
        let client = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(client.handle)
        await harness.emitEvent(.closed("code=Optional(messageTooLarge)"))
        // Fail the next three reconnect attempts; the fourth succeeds so the
        // loop terminates.
        harness.failNextConnects(3)

        for attempt in 1...2 {
            await attemptGate.step()
            try await self.waitUntil("reconnect attempt \(attempt)") {
                harness.connectAttemptCountSnapshot() >= attempt + 1
            }
            // One or two failures must not cut the client loose — Chrome may
            // still be coming back.
            XCTAssertEqual(client.closeCodesSnapshot(), [], "closed after \(attempt) failed attempt(s)")
        }

        await attemptGate.step()
        try await self.waitUntil("the client to be closed after three failed reconnects") {
            !client.closeCodesSnapshot().isEmpty
        }
        XCTAssertEqual(client.closeCodesSnapshot(), [.unknown(CDPProxy.upstreamResetCloseCode)])
        XCTAssertEqual(client.closeReasonsSnapshot(), ["upstream-reset"])

        await attemptGate.step()
        try await self.waitUntil("the reconnect loop to succeed on the fourth attempt") {
            harness.connectCountSnapshot() >= 2
        }
        // Closed exactly once: the eventual success finds no client to signal.
        XCTAssertEqual(client.closeCodesSnapshot(), [.unknown(CDPProxy.upstreamResetCloseCode)])
    }

    func testChromeMessagePumpOverflowSummarizesQueuedFrames() async {
        let messagePump = ChromeInboundMessagePump(maxBufferedMessages: 3)

        XCTAssertEqual(
            messagePump.enqueue(.text("{\"method\":\"Page.frameNavigated\",\"sessionId\":\"S1\"}")),
            .enqueued
        )
        XCTAssertEqual(
            messagePump.enqueue(.text("{\"method\":\"Page.frameNavigated\",\"sessionId\":\"S2\"}")),
            .enqueued
        )
        // No overflow yet — nothing to attribute.
        XCTAssertNil(messagePump.overflowDiagnosticsSummary())

        XCTAssertEqual(
            messagePump.enqueue(.text("{\"method\":\"Network.requestWillBeSent\",\"sessionId\":\"S2\"}")),
            .enqueued
        )
        XCTAssertEqual(messagePump.enqueue(.text("{\"method\":\"Page.loadEventFired\"}")), .overflow)

        let summary = messagePump.overflowDiagnosticsSummary()
        XCTAssertEqual(
            summary,
            "queued=3 distinctSessionIds=2 topMethods: Page.frameNavigated=2, Network.requestWillBeSent=1"
        )

        // The snapshot survives the drain, so the log line can be emitted after
        // the pump has been read out.
        await CDPProxy.runChromeMessagePump(messagePump) { _ in }
        XCTAssertEqual(messagePump.overflowDiagnosticsSummary(), summary)
    }

    func testInboundOverflowLogLineCarriesDiagnosticsAndFiresOnce() {
        let messagePump = ChromeInboundMessagePump(maxBufferedMessages: 1)
        let terminationState = ChromeSocketTerminationState()

        let enqueued = messagePump.enqueue(.text("{\"method\":\"Page.frameNavigated\",\"sessionId\":\"S1\"}"))
        XCTAssertNil(
            CDPProxy.inboundOverflowLogLine(
                result: enqueued,
                messagePump: messagePump,
                terminationState: terminationState
            )
        )

        let overflowed = messagePump.enqueue(.text("{\"method\":\"Page.frameNavigated\",\"sessionId\":\"S2\"}"))
        let logLine = CDPProxy.inboundOverflowLogLine(
            result: overflowed,
            messagePump: messagePump,
            terminationState: terminationState
        )

        XCTAssertEqual(
            logLine,
            "[cdp-proxy] Inbound Chrome frame buffer overflowed — "
                + "queued=1 distinctSessionIds=1 topMethods: Page.frameNavigated=1"
        )
        // The socket is torn down once, so only the first overflow logs; the
        // `.error` event still reports the unchanged cap message.
        XCTAssertNil(
            CDPProxy.inboundOverflowLogLine(
                result: .overflow,
                messagePump: messagePump,
                terminationState: terminationState
            )
        )
        XCTAssertEqual(
            terminationState.overflowDescriptionSnapshot(),
            "Inbound Chrome frame buffer overflowed (\(CDPProxy.defaultChromeInboundMessageBufferLimit) queued messages)"
        )
    }

    func testInboundOverflowDiagnosticsRanksTopMethodsAndCountsSessions() {
        var messages: [ProxyMessage] = []
        for index in 0..<6 {
            messages.append(.text("{\"method\":\"Network.requestWillBeSent\",\"params\":{},\"sessionId\":\"S\(index)\"}"))
        }
        for _ in 0..<5 {
            messages.append(.text("{\"method\":\"Page.frameNavigated\",\"sessionId\":\"S0\"}"))
        }
        for _ in 0..<4 {
            messages.append(.text("{\"method\":\"Page.lifecycleEvent\",\"sessionId\":\"S0\"}"))
        }
        for _ in 0..<3 {
            messages.append(.text("{\"method\":\"Network.responseReceived\",\"sessionId\":\"S0\"}"))
        }
        for _ in 0..<2 {
            messages.append(.text("{\"method\":\"Page.loadEventFired\",\"sessionId\":\"S0\"}"))
        }
        // Sixth method is ranked out; command replies carry no method at all.
        messages.append(.text("{\"method\":\"Runtime.consoleAPICalled\",\"sessionId\":\"S0\"}"))
        messages.append(.text("{\"id\":7,\"result\":{}}"))
        messages.append(.binary(ByteBuffer(bytes: [0x01, 0x02])))

        let summary = ChromeInboundOverflowDiagnostics.summary(for: messages)

        XCTAssertEqual(
            summary,
            "queued=23 distinctSessionIds=6 topMethods: Network.requestWillBeSent=6, Page.frameNavigated=5, "
                + "Page.lifecycleEvent=4, Network.responseReceived=3, Page.loadEventFired=2 (binaryFrames=1)"
        )
        XCTAssertFalse(summary.contains("Runtime.consoleAPICalled"))
    }

    func testInboundOverflowDiagnosticsHandlesFramesWithoutMethods() {
        let summary = ChromeInboundOverflowDiagnostics.summary(for: [.text("{\"id\":1,\"result\":{}}")])

        XCTAssertEqual(summary, "queued=1 distinctSessionIds=0 topMethods: none")
    }
}
