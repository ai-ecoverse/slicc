import Foundation
import Logging
import SliccTrayFollower
import XCTest

@testable import slicc_server

/// The pure translators of the federated-CDP servicer — swift-server's half of
/// "CDP over CDP" for egress-blocked Electron apps. Pinned against node-server's
/// `electron-federated-cdp.ts` message shapes and shared-ts `sendCDPResponse`
/// chunking.
final class FederatedCDPServicerTests: XCTestCase {

    // MARK: - targets.advertise

    func testBuildTargetsAdvertiseKeepsOnlyPagesAsBrowserKind() throws {
        let targets = [
            FederatedCdpInspectableTarget(id: "p1", type: "page", title: "Signal", url: "file:///a"),
            FederatedCdpInspectableTarget(id: "w1", type: "service_worker", title: "sw", url: "x"),
            FederatedCdpInspectableTarget(id: "p2", type: "page", title: nil, url: "file:///b"),
        ]
        let message = buildTargetsAdvertise(runtimeId: "rt-1", targets: targets)
        guard case .targetsAdvertise(let advertised, let runtimeId) = message else {
            return XCTFail("expected targets.advertise, got \(message)")
        }
        XCTAssertEqual(runtimeId, "rt-1")
        XCTAssertEqual(advertised.map(\.targetId), ["p1", "p2"])
        XCTAssertTrue(advertised.allSatisfy { $0.kind == "browser" })
        // A missing title becomes the empty string (never nil on the wire).
        XCTAssertEqual(advertised[1].title, "")
    }

    // MARK: - cdp.response (single / error / chunked)

    func testBuildCdpResponsesErrorIsSingleMessage() throws {
        let responses = buildCdpResponses(requestId: "r1", result: nil, error: "boom")
        XCTAssertEqual(responses.count, 1)
        guard case .cdpResponse(let requestId, let result, let error, let chunkData, _, _) = responses[0]
        else { return XCTFail("expected cdp.response") }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(error, "boom")
        XCTAssertNil(result)
        XCTAssertNil(chunkData)
    }

    func testBuildCdpResponsesSmallResultIsSingleUnchunkedMessage() throws {
        let responses = buildCdpResponses(
            requestId: "r2", result: ["title": "Signal (3)"], error: nil)
        XCTAssertEqual(responses.count, 1)
        guard
            case .cdpResponse(_, let result, let error, let chunkData, let chunkIndex, let total) =
                responses[0]
        else { return XCTFail("expected cdp.response") }
        XCTAssertNil(error)
        XCTAssertNil(chunkData)
        XCTAssertNil(chunkIndex)
        XCTAssertNil(total)
        XCTAssertNotNil(result)
    }

    func testBuildCdpResponsesLargeResultChunksAndRoundTrips() throws {
        // A >64 KB serialized result must be split into 32 KB chunkData slices
        // whose concatenation JSON-parses back to the original result.
        let big = String(repeating: "x", count: 200_000)
        let result: [String: Any] = ["data": big]
        let responses = buildCdpResponses(requestId: "r3", result: result, error: nil)
        XCTAssertGreaterThan(responses.count, 1)

        var reassembled = ""
        for (index, message) in responses.enumerated() {
            guard
                case .cdpResponse(let requestId, let res, let error, let chunkData, let chunkIndex, let total) =
                    message
            else { return XCTFail("expected cdp.response") }
            XCTAssertEqual(requestId, "r3")
            XCTAssertNil(res, "chunked responses carry no inline result")
            XCTAssertNil(error)
            XCTAssertEqual(chunkIndex, index, "chunk indices must be sequential")
            XCTAssertEqual(total, responses.count)
            reassembled += try XCTUnwrap(chunkData)
        }
        let parsed = try JSONSerialization.jsonObject(with: Data(reassembled.utf8)) as? [String: Any]
        XCTAssertEqual(parsed?["data"] as? String, big)
    }

    // MARK: - cdp.event

    func testBuildCdpEventCarriesMethodParamsSession() throws {
        let message = buildCdpEvent(
            method: "Target.targetCreated", params: ["targetInfo": ["type": "page"]],
            sessionId: "sess-9")
        guard case .cdpEvent(let method, let params, let sessionId) = message else {
            return XCTFail("expected cdp.event")
        }
        XCTAssertEqual(method, "Target.targetCreated")
        XCTAssertEqual(sessionId, "sess-9")
        let dict = params.value as? [String: Any]
        XCTAssertNotNil(dict?["targetInfo"])
    }

    func testBuildCdpEventDefaultsMissingParamsToEmptyObject() throws {
        let message = buildCdpEvent(method: "Page.loadEventFired", params: nil, sessionId: nil)
        guard case .cdpEvent(_, let params, let sessionId) = message else {
            return XCTFail("expected cdp.event")
        }
        XCTAssertNil(sessionId)
        XCTAssertNotNil(params.value as? [String: Any])
    }

    // MARK: - chunker

    func testChunkSerializedResultRespectsByteBudgetAndConcatenates() {
        let text = String(repeating: "é", count: 5_000)  // 2 UTF-8 bytes each
        let slices = chunkSerializedResult(text, maxBytes: 1_000)
        XCTAssertGreaterThan(slices.count, 1)
        for slice in slices {
            XCTAssertLessThanOrEqual(slice.utf8.count, 1_000)
        }
        XCTAssertEqual(slices.joined(), text)
    }

    func testChunkSerializedResultAlwaysReturnsAtLeastOneSlice() {
        XCTAssertEqual(chunkSerializedResult("", maxBytes: 1_000), [""])
    }

    // MARK: - frame correlation

    func testMessagesForCdpFrameCorrelatesResponsesAndDropsUnknownIds() {
        var pending: [Int: String] = [3: "req-3"]
        let responses = messagesForCdpFrame(["id": 3, "result": ["ok": true]], pending: &pending)
        XCTAssertEqual(responses.count, 1)
        XCTAssertNil(pending[3], "a correlated id is consumed from pending")

        // A reply whose id is not pending (already answered, or foreign) is dropped.
        XCTAssertTrue(messagesForCdpFrame(["id": 99, "result": [:]], pending: &pending).isEmpty)

        var errorPending: [Int: String] = [1: "req-1"]
        let errors = messagesForCdpFrame(["id": 1, "error": ["message": "nope"]], pending: &errorPending)
        guard case .cdpResponse(_, _, let error, _, _, _) = errors.first else {
            return XCTFail("expected cdp.response")
        }
        XCTAssertEqual(error, "nope")

        // A frame with a method and no id is an event; anything else is ignored.
        let events = messagesForCdpFrame(["method": "Page.loadEventFired"], pending: &pending)
        guard case .cdpEvent(let method, _, _) = events.first else {
            return XCTFail("expected cdp.event")
        }
        XCTAssertEqual(method, "Page.loadEventFired")
        XCTAssertTrue(messagesForCdpFrame(["foo": "bar"], pending: &pending).isEmpty)
    }

    // MARK: - actor lifecycle

    func testHandleCdpRequestWithoutConnectionRepliesNotConnected() async {
        let box = FollowerMessageBox()
        let servicer = FederatedCDPServicer(
            runtimeId: "rt", logger: Logger(label: "t"), send: { box.add($0) })
        await servicer.handleCdpRequest(
            requestId: "r1", method: "Runtime.evaluate", params: nil, sessionId: nil)
        guard case .cdpResponse(let requestId, _, let error, _, _, _) = box.messages.first else {
            return XCTFail("expected cdp.response")
        }
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(error, "cdp-not-connected")
    }

    func testAdvertiseTargetsEmitsTargetsAdvertise() async {
        let box = FollowerMessageBox()
        let servicer = FederatedCDPServicer(
            runtimeId: "rt-x", logger: Logger(label: "t"), send: { box.add($0) })
        await servicer.advertiseTargets([
            FederatedCdpInspectableTarget(id: "p1", type: "page", title: "T", url: "u")
        ])
        guard case .targetsAdvertise(let targets, let runtimeId) = box.messages.first else {
            return XCTFail("expected targets.advertise")
        }
        XCTAssertEqual(runtimeId, "rt-x")
        XCTAssertEqual(targets.first?.targetId, "p1")
    }

    func testServicerForwardsResponseAndEventOverTransport() async throws {
        let box = FollowerMessageBox()
        let servicer = FederatedCDPServicer(
            runtimeId: "rt", logger: Logger(label: "t"), send: { box.add($0) })
        let transport = MockCDPWebSocketTransport()
        await servicer.connect(transport: transport)

        await servicer.handleCdpRequest(
            requestId: "req-1", method: "Runtime.evaluate", params: ["expression": "1"],
            sessionId: "s1")
        let sent = await transport.sentFrames
        XCTAssertEqual(sent.count, 1)
        let sentObject = try JSONSerialization.jsonObject(with: sent[0]) as? [String: Any]
        XCTAssertEqual(sentObject?["method"] as? String, "Runtime.evaluate")
        XCTAssertEqual(sentObject?["sessionId"] as? String, "s1")
        let cdpId = try XCTUnwrap(sentObject?["id"] as? Int)

        // The app replies → a cdp.response for req-1 is emitted.
        await transport.push(#"{"id":\#(cdpId),"result":{"value":42}}"#)
        try await waitUntil {
            box.messages.contains {
                if case .cdpResponse(let requestId, _, _, _, _, _) = $0 { return requestId == "req-1" }
                return false
            }
        }

        // An unsolicited event → cdp.event forwarded.
        await transport.push(#"{"method":"Target.targetCreated","params":{"targetInfo":{}}}"#)
        try await waitUntil {
            box.messages.contains {
                if case .cdpEvent(let method, _, _) = $0 { return method == "Target.targetCreated" }
                return false
            }
        }

        // `stop()` cancels the transport from a detached Task, so poll for it.
        await servicer.stop()
        var cancelled = false
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            cancelled = await transport.cancelled
            if cancelled { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(cancelled)
    }

    func testStopRejectsInFlightRequests() async {
        let box = FollowerMessageBox()
        let servicer = FederatedCDPServicer(
            runtimeId: "rt", logger: Logger(label: "t"), send: { box.add($0) })
        let transport = MockCDPWebSocketTransport()
        await servicer.connect(transport: transport)
        await servicer.handleCdpRequest(requestId: "r9", method: "X", params: nil, sessionId: nil)

        await servicer.stop()

        XCTAssertTrue(
            box.messages.contains {
                if case .cdpResponse(let requestId, _, let error, _, _, _) = $0 {
                    return requestId == "r9" && error == "cdp-closed"
                }
                return false
            })
    }

    private func waitUntil(
        timeout: TimeInterval = 2, _ condition: @escaping () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("waitUntil timed out")
    }
}

/// Thread-safe capture of the follower→leader messages a servicer emits.
final class FollowerMessageBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [FollowerToLeaderMessage] = []

    func add(_ message: FollowerToLeaderMessage) {
        lock.lock()
        storage.append(message)
        lock.unlock()
    }

    var messages: [FollowerToLeaderMessage] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// A `CDPWebSocketTransport` double: records sent frames and lets the test feed
/// inbound CDP frames on demand, so the servicer's frame pump runs without a
/// live browser.
actor MockCDPWebSocketTransport: CDPWebSocketTransport {
    private var queued: [URLSessionWebSocketTask.Message] = []
    private var waiter: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private(set) var sentFrames: [Data] = []
    private(set) var cancelled = false

    func push(_ text: String) {
        let message = URLSessionWebSocketTask.Message.string(text)
        if let waiter = waiter {
            self.waiter = nil
            waiter.resume(returning: message)
        } else {
            queued.append(message)
        }
    }

    func sendFrame(_ payload: Data) async throws {
        sentFrames.append(payload)
    }

    func receiveFrame() async throws -> URLSessionWebSocketTask.Message {
        if !queued.isEmpty { return queued.removeFirst() }
        return try await withCheckedThrowingContinuation { continuation in
            waiter = continuation
        }
    }

    func cancelSocket() async {
        cancelled = true
        waiter?.resume(throwing: CancellationError())
        waiter = nil
    }
}
