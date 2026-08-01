import XCTest

@testable import SliccFollower

/// The `user_message.steer` wire contract: optional on the wire — omitted
/// when false, present when true — and tolerated on decode either way.
final class SteerMessageTests: XCTestCase {
    func testSteerIsOmittedWhenFalse() throws {
        let data = try JSONEncoder().encode(
            FollowerToLeaderMessage.userMessage(text: "hi", messageId: "m1"))
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(obj["steer"], "steer is optional on the wire — omit rather than send false")
        XCTAssertEqual(obj["type"] as? String, "user_message")
    }

    func testSteerIsEncodedWhenTrue() throws {
        let data = try JSONEncoder().encode(
            FollowerToLeaderMessage.userMessage(text: "hi", messageId: "m1", steer: true))
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["steer"] as? Bool, true)
    }

    func testDecodeDefaultsSteerToFalse() throws {
        let json = #"{"type":"user_message","text":"hi","messageId":"m1"}"#
        let decoded = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: Data(json.utf8))
        guard case .userMessage(_, _, let steer) = decoded else {
            return XCTFail("expected userMessage")
        }
        XCTAssertFalse(steer)
    }

    @MainActor
    func testComposerTargetsLeaderActiveScoopGatesOnMismatchOnly() {
        let state = AppState()
        // Unknown on either side errs permissive (pre-scoop leaders).
        XCTAssertTrue(state.composerTargetsLeaderActiveScoop)
        state.selectedScoopJid = "scoop-a"
        XCTAssertTrue(state.composerTargetsLeaderActiveScoop)
        state.leaderActiveScoopJid = "scoop-a"
        XCTAssertTrue(state.composerTargetsLeaderActiveScoop)
        state.leaderActiveScoopJid = "scoop-b"
        XCTAssertFalse(state.composerTargetsLeaderActiveScoop)
    }

    func testDecodeRoundTripsSteerTrue() throws {
        let json = #"{"type":"user_message","text":"hi","messageId":"m1","steer":true}"#
        let decoded = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: Data(json.utf8))
        guard case .userMessage(_, _, let steer) = decoded else {
            return XCTFail("expected userMessage")
        }
        XCTAssertTrue(steer)
    }
}
