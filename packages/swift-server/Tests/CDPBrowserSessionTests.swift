import XCTest

@testable import slicc_server

final class CDPBrowserSessionTests: XCTestCase {
    private func result(_ json: String, id: Int) -> String? {
        WebSocketCDPBrowserSession.result(fromFrame: Data(json.utf8), id: id)
            .map { String(decoding: $0, as: UTF8.self) }
    }

    func testReturnsTheResultOfTheMatchingReply() {
        XCTAssertEqual(
            result(#"{"id":7,"result":{"defaultBrowserContextId":"CTX"}}"#, id: 7),
            #"{"defaultBrowserContextId":"CTX"}"#
        )
    }

    func testSkipsEventsAndOtherRepliesSoAReadLoopKeepsGoing() {
        // Browser-level target lifecycle events interleave with replies.
        XCTAssertNil(result(#"{"method":"Target.targetCreated","params":{}}"#, id: 7))
        XCTAssertNil(result(#"{"id":6,"result":{}}"#, id: 7))
        XCTAssertNil(result("not json", id: 7))
        XCTAssertNil(result("[1,2,3]", id: 7))
    }

    func testTreatsAReplyWithoutAResultAsAnEmptyObject() {
        // An error reply still answers the id; the decoder above then reports
        // the missing field rather than the read hanging for more frames.
        XCTAssertEqual(result(#"{"id":7,"error":{"code":-32000}}"#, id: 7), "{}")
    }

    func testNoReplyErrorNamesTheMethod() {
        XCTAssertEqual(
            CDPBrowserSessionError.noReply(method: "Target.getTargets").errorDescription,
            "The browser did not reply to Target.getTargets."
        )
    }

    func testCallNumbersItsCommandsAndReadsPastInterleavedFrames() async throws {
        let socket = SocketStub(frames: [
            .string(#"{"method":"Target.targetCreated","params":{}}"#),
            .data(Data(#"{"id":99,"result":{"stale":true}}"#.utf8)),
            .string(#"{"id":1,"result":{"browserContextIds":["CTX"]}}"#),
            .string(#"{"id":2,"result":{"targetInfos":[]}}"#),
        ])
        let session = WebSocketCDPBrowserSession(socket: socket)

        let contexts = try await session.call(method: "Target.getBrowserContexts")
        let targets = try await session.call(method: "Target.getTargets")

        XCTAssertEqual(String(decoding: contexts, as: UTF8.self), #"{"browserContextIds":["CTX"]}"#)
        XCTAssertEqual(String(decoding: targets, as: UTF8.self), #"{"targetInfos":[]}"#)
        // Ids increment per call, which is what lets the loop above tell this
        // call's reply from the previous one's.
        let sent = await socket.sentCommands()
        XCTAssertEqual(sent.map(\.id), [1, 2])
        XCTAssertEqual(sent.map(\.method), ["Target.getBrowserContexts", "Target.getTargets"])
    }

    func testCallGivesUpOnABrowserThatOnlyEmitsEvents() async {
        // Without the frame budget a chatty browser would pin the caller for
        // as long as it keeps talking.
        let event = URLSessionWebSocketTask.Message.string(#"{"method":"Target.targetInfoChanged"}"#)
        let socket = SocketStub(frames: Array(repeating: event, count: 256))
        let session = WebSocketCDPBrowserSession(socket: socket)

        do {
            _ = try await session.call(method: "Target.getTargets")
            XCTFail("expected the call to give up")
        } catch {
            XCTAssertEqual(
                (error as? CDPBrowserSessionError)?.errorDescription,
                CDPBrowserSessionError.noReply(method: "Target.getTargets").errorDescription
            )
        }
    }

    func testAClosedPortSurfacesAsAThrownErrorRatherThanAHang() async {
        // Production wiring, no browser behind it: the recorder polls on the
        // shutdown path, so a refused connection has to come back as an error.
        let session = WebSocketCDPBrowserSession(url: URL(string: "ws://127.0.0.1:1/devtools/browser/none")!)

        do {
            _ = try await session.call(method: "Target.getTargets")
            XCTFail("expected the call to fail")
        } catch {
            XCTAssertNotNil(error)
        }
        await session.close()
    }

    func testCloseCancelsTheSocket() async {
        let socket = SocketStub(frames: [])
        let session = WebSocketCDPBrowserSession(socket: socket)

        await session.close()

        let cancelled = await socket.wasCancelled()
        XCTAssertTrue(cancelled)
    }
}

/// Replays a scripted frame sequence, the way a browser interleaves target
/// events with command replies.
private actor SocketStub: CDPWebSocketTransport {
    struct Command {
        let id: Int
        let method: String
    }

    private var frames: [URLSessionWebSocketTask.Message]
    private var sent: [Command] = []
    private var cancelled = false

    init(frames: [URLSessionWebSocketTask.Message]) {
        self.frames = frames
    }

    func sendFrame(_ payload: Data) async throws {
        let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any]
        sent.append(
            Command(
                id: object?["id"] as? Int ?? -1,
                method: object?["method"] as? String ?? ""
            )
        )
    }

    func receiveFrame() async throws -> URLSessionWebSocketTask.Message {
        guard !frames.isEmpty else { throw CancellationError() }
        return frames.removeFirst()
    }

    func cancelSocket() {
        cancelled = true
    }

    func sentCommands() -> [Command] { sent }
    func wasCancelled() -> Bool { cancelled }
}
