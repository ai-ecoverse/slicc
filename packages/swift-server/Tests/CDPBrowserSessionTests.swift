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
}
