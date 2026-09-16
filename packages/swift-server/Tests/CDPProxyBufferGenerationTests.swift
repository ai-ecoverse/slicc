import Foundation
import Logging
import NIOWebSocket
import XCTest

@testable import slicc_server

final class CDPProxyBufferGenerationTests: XCTestCase {

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

        XCTAssertEqual(ClientFrameBufferDropReason.chromeLegReset.rawValue, "chrome-leg-reset")
        XCTAssertEqual(ClientFrameBufferDropReason.clientSuperseded.rawValue, "client-superseded")
        XCTAssertEqual(ClientFrameBufferDropReason.clientDisconnected.rawValue, "client-disconnected")
        XCTAssertEqual(ClientFrameBufferDropReason.upstreamReset.rawValue, "upstream-reset")
        XCTAssertEqual(ClientFrameBufferDropReason.noClient.rawValue, "no-client")
    }

    func testInitialConnectBufferStillFlushesOntoTheFirstConnection() async {

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

        await proxy.addClient(second.handle)
        await proxy.receive(.text("{\"id\":2,\"method\":\"Target.getTargets\"}"), from: second.handle.id)

        await harness.resumePendingConnection()
        await prepareTask.value

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

        XCTAssertEqual(harness.sentTextsSnapshot(), [])
    }

    func testReconnectLoopHasNoAttemptCap() async throws {

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

        XCTAssertEqual(client.closeCodesSnapshot(), [.unknown(CDPProxy.upstreamResetCloseCode)])
    }

    func testSuccessAfterFailuresLeavesAClientThatConnectedInTheMeantimeConnected() async throws {

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

        await proxy.addClient(second.handle)
        XCTAssertEqual(second.closeCodesSnapshot(), [])

        await attemptGate.step()
        try await self.waitUntil("the reconnect to succeed on the fourth attempt") {
            harness.connectCountSnapshot() >= 2
        }

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
