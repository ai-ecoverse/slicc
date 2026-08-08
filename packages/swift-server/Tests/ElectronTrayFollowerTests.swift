import Foundation
import Logging
import SliccTrayFollower
import WebRTC
import XCTest

@testable import slicc_server

/// The headless tray follower's message dispatch (ping→pong, transport chunk
/// reassembly) and the egress-block → follower-start trigger. The signalling +
/// WebRTC transport is the shared `TrayFollowerConnector` (exercised by the iOS
/// package), so these tests cover only the swift-server-local servicing layer.
final class ElectronTrayFollowerTests: XCTestCase {

    private func makeFollower() -> ElectronTrayFollower {
        ElectronTrayFollower(
            cdpPort: 9223,
            joinURL: URL(string: "http://127.0.0.1:1/join")!,
            logger: Logger(label: "test.follower"))
    }

    /// Capture messages the follower sends to the leader by decoding the raw
    /// data-channel frames it hands to the injected send sink.
    private func captureSends(_ follower: ElectronTrayFollower) -> () -> [FollowerToLeaderMessage] {
        let box = NSMutableArray()
        follower._testing_installChannelSend { data in
            if let message = try? JSONDecoder().decode(FollowerToLeaderMessage.self, from: data) {
                box.add(message)
            }
            return true
        }
        return { box.compactMap { $0 as? FollowerToLeaderMessage } }
    }

    func testRoutePingSendsPong() {
        let follower = makeFollower()
        let sent = captureSends(follower)

        follower.route(.ping)

        let messages = sent()
        XCTAssertEqual(messages.count, 1)
        guard case .pong = messages[0] else { return XCTFail("expected pong, got \(messages)") }
    }

    func testDispatchInboundDecodesPlainPing() {
        let follower = makeFollower()
        let sent = captureSends(follower)

        follower.dispatchInbound(Data(#"{"type":"ping"}"#.utf8))

        guard case .pong = sent().first else { return XCTFail("expected pong") }
    }

    func testDispatchInboundReassemblesChunkedMessageBeforeRouting() throws {
        let follower = makeFollower()
        let sent = captureSends(follower)

        // Split `{"type":"ping"}` across two transport `__chunk` frames; a pong
        // must only be produced once BOTH frames have arrived and reassembled.
        let frame0 = TrayChunkFrame(
            type: TrayChunkFrame.typeTag, chunkId: "c1", chunkIndex: 0, totalChunks: 2,
            chunkData: #"{"type":"#)
        let frame1 = TrayChunkFrame(
            type: TrayChunkFrame.typeTag, chunkId: "c1", chunkIndex: 1, totalChunks: 2,
            chunkData: #""ping"}"#)
        let encoder = JSONEncoder()

        follower.dispatchInbound(try encoder.encode(frame0))
        XCTAssertTrue(sent().isEmpty, "no message until the last chunk arrives")

        follower.dispatchInbound(try encoder.encode(frame1))
        guard case .pong = sent().first else { return XCTFail("expected pong after reassembly") }
    }

    func testDispatchInboundIgnoresUndecodableFrames() {
        let follower = makeFollower()
        let sent = captureSends(follower)

        follower.dispatchInbound(Data("not json".utf8))
        follower.dispatchInbound(Data(#"{"type":"totally_unknown"}"#.utf8))

        XCTAssertTrue(sent().isEmpty)
    }

    // MARK: - egress-block → follower start trigger

    func testInjectorFiresOnEgressBlockedOnceForFirstTarget() {
        let injector = ElectronOverlayInjector(_testingServePort: 5710)
        let fired = NSMutableArray()
        injector.onEgressBlocked = { url in fired.add(url) }

        injector.markEgressBlockedAndNotify("file:///a")
        injector.markEgressBlockedAndNotify("file:///b")

        // Fires exactly once (on the first blocked target), but both URLs are
        // recorded so the escalation is skipped for each.
        XCTAssertEqual(fired as? [String], ["file:///a"])
        XCTAssertEqual(injector._testing_egressBlockedURLs(), ["file:///a", "file:///b"])
    }

    // MARK: - channel-open handshake + endpoint parsing

    func testDidConnectSendsHelloOnChannelOpen() {
        let follower = makeFollower()
        let box = FollowerMessageBox()
        let connector = TrayFollowerConnector(joinUrl: URL(string: "http://127.0.0.1:1/join")!)

        follower.connector(connector) { data in
            if let message = try? JSONDecoder().decode(FollowerToLeaderMessage.self, from: data) {
                box.add(message)
            }
            return true
        }

        guard case .hello(let version, let runtime, _, _) = box.messages.first else {
            return XCTFail("expected hello on channel open")
        }
        XCTAssertEqual(version, traySyncProtocolVersion)
        XCTAssertEqual(runtime, "slicc-electron")
    }

    func testLoggingDelegateCallbacksAreInertNoOps() {
        let follower = makeFollower()
        let connector = TrayFollowerConnector(joinUrl: URL(string: "http://127.0.0.1:1/join")!)
        // Exercise the informational delegate callbacks — they only log, but must
        // not crash and keep the follower usable.
        follower.connectorDidDisconnect(connector, reason: "ice failed")
        follower.connector(connector, isReconnecting: 2)
        follower.connector(connector, didGiveUp: "gave up")
        follower.connector(connector, didReceiveInfo: "tray-1", participantCount: 1)
        follower.connector(
            connector,
            didGenerateCandidate: RTCIceCandidate(sdp: "candidate:0 1 UDP", sdpMLineIndex: 0, sdpMid: "0"))
    }

    func testParseBrowserWebSocketURL() {
        let good = Data(#"{"webSocketDebuggerUrl":"ws://127.0.0.1:9223/devtools/browser/abc"}"#.utf8)
        XCTAssertEqual(
            ElectronTrayFollower.parseBrowserWebSocketURL(from: good)?.absoluteString,
            "ws://127.0.0.1:9223/devtools/browser/abc")
        XCTAssertNil(ElectronTrayFollower.parseBrowserWebSocketURL(from: Data("{}".utf8)))
        XCTAssertNil(ElectronTrayFollower.parseBrowserWebSocketURL(from: Data("not json".utf8)))
    }

    func testParseInspectableTargetsDropsEntriesMissingFields() {
        let json = """
            [{"id":"p1","type":"page","title":"Signal","url":"file:///a"},
             {"id":"w1","type":"worker","url":"x"},
             {"type":"page","url":"no-id"}]
            """
        let targets = ElectronTrayFollower.parseInspectableTargets(from: Data(json.utf8))
        XCTAssertEqual(targets.map(\.id), ["p1", "w1"])
        XCTAssertEqual(targets.first?.title, "Signal")
        XCTAssertTrue(ElectronTrayFollower.parseInspectableTargets(from: Data("{}".utf8)).isEmpty)
    }

    func testRouteCdpRequestWithoutServicerIsInert() {
        let follower = makeFollower()
        let sent = captureSends(follower)
        follower.route(
            .cdpRequest(
                requestId: "r", localTargetId: "t", method: "Runtime.evaluate",
                params: AnyCodable(["expression": "1"]), sessionId: "s"))
        // No servicer connected → the request dispatches to a nil servicer
        // (no-op) and nothing is sent back synchronously.
        XCTAssertTrue(sent().isEmpty)
    }

    func testStartIfNeededIsIdempotentAndStopIsSafe() {
        // An unreachable CDP port makes the background resolve fail fast, so the
        // follower never actually joins a tray during this lifecycle test.
        let follower = ElectronTrayFollower(
            cdpPort: 1,
            joinURL: URL(string: "http://127.0.0.1:1/join")!,
            logger: Logger(label: "test.follower"))
        follower.startIfNeeded()
        follower.startIfNeeded()  // second call is a no-op (already started)
        follower.stop()
        follower.startIfNeeded()  // after stop, also a no-op
    }
}
