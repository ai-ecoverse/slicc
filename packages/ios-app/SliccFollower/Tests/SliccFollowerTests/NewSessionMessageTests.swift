import XCTest

@testable import SliccFollower

/// The `new_session` wire contract: all three dispositions encode with the
/// canonical string values and decode back.
final class NewSessionMessageTests: XCTestCase {
    func testAllThreeActionsRoundTrip() throws {
        for (action, wire) in [
            (NewSessionAction.save, "save"),
            (NewSessionAction.skip, "skip"),
            (NewSessionAction.erase, "erase"),
        ] {
            let data = try JSONEncoder().encode(
                FollowerToLeaderMessage.newSession(action: action))
            let obj = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(obj["type"] as? String, "new_session")
            XCTAssertEqual(obj["action"] as? String, wire)

            let decoded = try JSONDecoder().decode(FollowerToLeaderMessage.self, from: data)
            guard case .newSession(let roundTripped) = decoded else {
                return XCTFail("expected newSession")
            }
            XCTAssertEqual(roundTripped, action)
        }
    }

    func testUnknownActionFailsToDecode() {
        let json = #"{"type":"new_session","action":"shred"}"#
        XCTAssertThrowsError(
            try JSONDecoder().decode(FollowerToLeaderMessage.self, from: Data(json.utf8)))
    }
}
