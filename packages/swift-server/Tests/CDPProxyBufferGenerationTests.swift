import Foundation
import Logging
import NIOWebSocket
import XCTest

@testable import slicc_server

/// Generation-tagged Client→Chrome buffering and the shared reconnect policy —
/// the swift half of issue #2417 review findings 1 and 8. Byte-mirrors the
/// node-server suite in `packages/node-server/tests/cdp-proxy/`. Shared doubles
/// live in `CDPProxyTestSupport.swift`.
final class CDPProxyBufferGenerationTests: XCTestCase {

    // MARK: - The policy on its own

    func testDropReasonAllowsAMatchingGeneration() {
        let chrome = UUID()
        let client = UUID()

        XCTAssertNil(
            CDPProxy.clientFrameBufferDropReason(
                generation: ClientFrameBufferGeneration(chromeConnectionID: chrome, clientID: client),
                chromeConnectionID: chrome,
                clientID: client
            )
        )
    }

    func testDropReasonAllowsAnInitialConnectBufferOntoAnyConnection() {
        // No leg was live when buffering started, so no sessions were lost and
        // the frames still mean what they meant. This is the ONE case that
        // keeps flushing after #2417.
        let client = UUID()

        XCTAssertNil(
            CDPProxy.clientFrameBufferDropReason(
                generation: ClientFrameBufferGeneration(chromeConnectionID: nil, clientID: client),
                chromeConnectionID: UUID(),
                clientID: client
            )
        )
    }

    func testDropReasonRejectsAReplacedChromeConnection() {
        let client = UUID()

        XCTAssertEqual(
            CDPProxy.clientFrameBufferDropReason(
                generation: ClientFrameBufferGeneration(chromeConnectionID: UUID(), clientID: client),
                chromeConnectionID: UUID(),
                clientID: client
            ),
            .chromeLegReset
        )
    }

    func testDropReasonRejectsASupersededClient() {
        let chrome = UUID()

        XCTAssertEqual(
            CDPProxy.clientFrameBufferDropReason(
                generation: ClientFrameBufferGeneration(chromeConnectionID: chrome, clientID: UUID()),
                chromeConnectionID: chrome,
                clientID: UUID()
            ),
            .clientSuperseded
        )
    }

    func testDropReasonRejectsAnEmptySlot() {
        let chrome = UUID()

        XCTAssertEqual(
            CDPProxy.clientFrameBufferDropReason(
                generation: ClientFrameBufferGeneration(chromeConnectionID: chrome, clientID: UUID()),
                chromeConnectionID: chrome,
                clientID: nil
            ),
            .noClient
        )
    }

    func testDropReasonsMatchTheNodeServerWireStrings() {
        // The `[cdp-proxy] Dropped N buffered client frame(s) — <reason>` line
        // must read identically on both floats.
        XCTAssertEqual(ClientFrameBufferDropReason.chromeLegReset.rawValue, "chrome-leg-reset")
        XCTAssertEqual(ClientFrameBufferDropReason.clientSuperseded.rawValue, "client-superseded")
        XCTAssertEqual(ClientFrameBufferDropReason.clientDisconnected.rawValue, "client-disconnected")
        XCTAssertEqual(ClientFrameBufferDropReason.upstreamReset.rawValue, "upstream-reset")
        XCTAssertEqual(ClientFrameBufferDropReason.noClient.rawValue, "no-client")
    }

    // MARK: - The policy through the proxy

    func testInitialConnectBufferStillFlushesOntoTheFirstConnection() async {
        // The pre-#2417 behaviour that must NOT regress: a client that connects
        // before Chrome is ready keeps its queued frames.
        let harness = ChromeConnectorHarness(waitForExplicitResume: true)
        let proxy = self.makeProxy(harness: harness)
        let client = ClientRecorder()

        await proxy.addClient(client.handle)
        let prepareTask = Task {
            await proxy.prepareClientConnection(for: client.handle.id, cdpPort: 9222)
        }
        await proxy.receive(.text("{\"id\":1,\"method\":\"Target.getTargets\"}"), from: client.handle.id)

        await harness.resumePendingConnection()
        await prepareTask.value

        XCTAssertEqual(harness.sentTextsSnapshot(), ["{\"id\":1,\"method\":\"Target.getTargets\"}"])
    }

    func testSupersededClientBufferIsDroppedRatherThanRunUnderTheNewClient() async {
        let harness = ChromeConnectorHarness(waitForExplicitResume: true)
        let proxy = self.makeProxy(harness: harness)
        let first = ClientRecorder()
        let second = ClientRecorder()

        await proxy.addClient(first.handle)
        let prepareTask = Task {
            await proxy.prepareClientConnection(for: first.handle.id, cdpPort: 9222)
        }
        await proxy.receive(.text("{\"id\":1,\"method\":\"Target.createTarget\"}"), from: first.handle.id)

        // A second SLICC tab takes the single slot; the first is evicted with 4001.
        await proxy.addClient(second.handle)
        await proxy.receive(.text("{\"id\":2,\"method\":\"Target.getTargets\"}"), from: second.handle.id)

        await harness.resumePendingConnection()
        await prepareTask.value

        // Only the surviving client's frame runs. The evicted client's
        // `Target.createTarget` would otherwise open a tab nobody asked for.
        XCTAssertEqual(harness.sentTextsSnapshot(), ["{\"id\":2,\"method\":\"Target.getTargets\"}"])
        XCTAssertEqual(first.closeCodesSnapshot(), [.unknown(CDPProxy.supersededCloseCode)])
    }

    func testBufferIsDroppedWhenTheClientLeavesBeforeChromeIsBack() async {
        let harness = ChromeConnectorHarness(waitForExplicitResume: true)
        let proxy = self.makeProxy(harness: harness)
        let client = ClientRecorder()

        await proxy.addClient(client.handle)
        let prepareTask = Task {
            await proxy.prepareClientConnection(for: client.handle.id, cdpPort: 9222)
        }
        await proxy.receive(.text("{\"id\":1,\"method\":\"Target.createTarget\"}"), from: client.handle.id)
        await proxy.removeClient(id: client.handle.id, reason: "[cdp-proxy] Client disconnected")

        await harness.resumePendingConnection()
        await prepareTask.value

        // Never leave a clientless buffer around — nobody is waiting for these
        // replies and the frames name sessions that died with the client.
        XCTAssertEqual(harness.sentTextsSnapshot(), [])
    }

    // MARK: - Reconnect policy parity

    func testReconnectLoopHasNoAttemptCap() async throws {
        // node-server used to stop after 10 attempts; the shared policy retries
        // until shutdown, so an outage longer than the old cap still recovers
        // without a fresh client to drive discovery.
        let attemptGate = StepGate()
        let harness = ChromeConnectorHarness()
        let proxy = self.makeProxy(harness: harness, sleep: { _ in await attemptGate.wait() })
        let client = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(client.handle)
        await harness.emitEvent(.closed("code=Optional(messageTooLarge)"))

        let failures = 12
        harness.failNextConnects(failures)
        for attempt in 1...failures {
            await attemptGate.step()
            try await self.waitUntil("reconnect attempt \(attempt)") {
                harness.connectAttemptCountSnapshot() >= attempt + 1
            }
        }

        await attemptGate.step()
        try await self.waitUntil("the reconnect to succeed after \(failures) failures") {
            harness.connectCountSnapshot() >= 2
        }

        // Closed exactly once, on the 3rd failure: the eventual success finds
        // the slot already empty.
        XCTAssertEqual(client.closeCodesSnapshot(), [.unknown(CDPProxy.upstreamResetCloseCode)])
    }

    func testSuccessAfterFailuresLeavesAClientThatConnectedInTheMeantimeConnected() async throws {
        // The refined half of the policy: a successful reconnect resets ONLY the
        // client that held the slot when the leg went down. The failure-threshold
        // close emptied the slot, so the replacement — which never had sessions on
        // the dead leg — keeps its connection.
        let attemptGate = StepGate()
        let harness = ChromeConnectorHarness()
        let proxy = self.makeProxy(harness: harness, sleep: { _ in await attemptGate.wait() })
        let first = ClientRecorder()
        let second = ClientRecorder()

        try await proxy.preWarm(cdpPort: 9222)
        await proxy.addClient(first.handle)
        await harness.emitEvent(.closed("code=Optional(messageTooLarge)"))
        harness.failNextConnects(3)

        for attempt in 1...3 {
            await attemptGate.step()
            try await self.waitUntil("reconnect attempt \(attempt)") {
                harness.connectAttemptCountSnapshot() >= attempt + 1
            }
        }
        try await self.waitUntil("the first client to be cut loose") {
            !first.closeCodesSnapshot().isEmpty
        }

        // A fresh tab dials in while the leg is still down; it is NOT closed as
        // "superseded", because the reset already emptied the slot.
        await proxy.addClient(second.handle)
        XCTAssertEqual(second.closeCodesSnapshot(), [])

        await attemptGate.step()
        try await self.waitUntil("the reconnect to succeed on the fourth attempt") {
            harness.connectCountSnapshot() >= 2
        }

        // Nobody is reset by that success: the stale client is long gone and the
        // replacement's commands already ran on the fresh leg — a 4002 here would
        // make the page retry them (duplicate `Target.createTarget`, issue #2417).
        XCTAssertEqual(second.closeCodesSnapshot(), [])
        XCTAssertEqual(first.closeCodesSnapshot(), [.unknown(CDPProxy.upstreamResetCloseCode)])
    }

    private func makeProxy(
        harness: ChromeConnectorHarness,
        sleep: (@Sendable (UInt64) async throws -> Void)? = nil
    ) -> CDPProxy {
        CDPProxy(
            logger: Logger(label: "test.cdp-proxy"),
            discoverer: { _ in "ws://127.0.0.1:9222/devtools/browser/test" },
            chromeConnector: { url, onMessage, onEvent in
                try await harness.connect(url: url, onMessage: onMessage, onEvent: onEvent)
            },
            reconnectDelayNanoseconds: 0,
            sleep: sleep ?? { try await Task.sleep(nanoseconds: $0) }
        )
    }
}
