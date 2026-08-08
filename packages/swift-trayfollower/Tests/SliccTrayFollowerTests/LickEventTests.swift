import Foundation
import XCTest

@testable import SliccTrayFollower

/// The generic `lick` envelope: `FollowerLickType` and the partial `LickEvent`
/// mirror, whose synthesized Codable omits every nil field.
final class LickEventTests: XCTestCase {

    func testFollowerLickTypeRoundTrips() throws {
        XCTAssertEqual(try WireCodec.roundTrip(FollowerLickType.navigate), .navigate)
        XCTAssertEqual(try WireCodec.roundTrip(FollowerLickType.discovery), .discovery)
    }

    func testNavigateLickRoundTrip() throws {
        let body = try WireCodec.anyCodable(#"{"url":"https://x","verb":"handoff"}"#)
        let event = LickEvent(
            type: .navigate, timestamp: "2026-08-08T00:00:00.000Z", body: body, navigateUrl: "https://x")
        let decoded = try WireCodec.roundTrip(event)
        XCTAssertEqual(decoded.type, .navigate)
        XCTAssertEqual(decoded.timestamp, "2026-08-08T00:00:00.000Z")
        XCTAssertEqual(decoded.navigateUrl, "https://x")
        // Compare the multi-key body by canonical (sorted-key) JSON, since
        // `AnyCodable`'s byte-wise `==` is order-sensitive.
        XCTAssertEqual(try WireCodec.canonical(decoded.body), try WireCodec.canonical(body))
    }

    func testDiscoveryLickRoundTrip() throws {
        let event = LickEvent(
            type: .discovery, timestamp: "2026-08-08T00:00:00.000Z", body: nil,
            discoveryOrigin: "https://origin", discoveryKind: "skill", discoveryUrl: "https://origin/manifest.json")
        XCTAssertEqual(try WireCodec.roundTrip(event), event)
    }

    func testNilFieldsAreOmittedFromWire() throws {
        let event = LickEvent(type: .navigate, timestamp: "2026-08-08T00:00:00.000Z", body: nil)
        let json = try WireCodec.jsonString(event)
        XCTAssertFalse(json.contains("navigateUrl"))
        XCTAssertFalse(json.contains("discoveryOrigin"))
        XCTAssertFalse(json.contains("targetScoop"))
        XCTAssertTrue(json.contains("\"type\":\"navigate\""))
    }

    func testTargetScoopRoundTrip() throws {
        let event = LickEvent(
            type: .navigate, timestamp: "2026-08-08T00:00:00.000Z", body: nil, targetScoop: "j1")
        XCTAssertEqual(try WireCodec.roundTrip(event), event)
    }

    func testDecodeFromBrowserFollowerShape() throws {
        let json = #"{"type":"navigate","timestamp":"2026-08-08T00:00:00.000Z","navigateUrl":"https://x"}"#
        let decoded = try WireCodec.decode(LickEvent.self, from: json)
        XCTAssertEqual(decoded.type, .navigate)
        XCTAssertEqual(decoded.timestamp, "2026-08-08T00:00:00.000Z")
        XCTAssertEqual(decoded.navigateUrl, "https://x")
        XCTAssertNil(decoded.body)
    }
}
