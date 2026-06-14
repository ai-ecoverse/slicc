import XCTest
@testable import SwiftOptel

final class RUMEventTests: XCTestCase {
    private func encode(_ event: RUMEvent) throws -> [String: Any] {
        let data = try JSONEncoder().encode(event)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "RUMEventTests", code: 1)
        }
        return json
    }

    func testCheckpointRawValues() {
        XCTAssertEqual(RUMCheckpoint.top.rawValue, "top")
        XCTAssertEqual(RUMCheckpoint.enter.rawValue, "enter")
        XCTAssertEqual(RUMCheckpoint.navigate.rawValue, "navigate")
        XCTAssertEqual(RUMCheckpoint.reload.rawValue, "reload")
        XCTAssertEqual(RUMCheckpoint.cwv.rawValue, "cwv")
        XCTAssertEqual(RUMCheckpoint.pagesviewed.rawValue, "pagesviewed")
        XCTAssertEqual(RUMCheckpoint.click.rawValue, "click")
        XCTAssertEqual(RUMCheckpoint.viewblock.rawValue, "viewblock")
        XCTAssertEqual(RUMCheckpoint.viewmedia.rawValue, "viewmedia")
        XCTAssertEqual(RUMCheckpoint.formsubmit.rawValue, "formsubmit")
        XCTAssertEqual(RUMCheckpoint.error.rawValue, "error")
        XCTAssertEqual(RUMCheckpoint.raw("custom-cp").rawValue, "custom-cp")
    }

    func testEncodesFullEventWithFlattenedPingData() throws {
        let event = RUMEvent(
            weight: 100,
            id: "abc123def",
            referer: "https://com.example.app/home",
            checkpoint: .click,
            t: 1234,
            pingData: RUMPingData(source: ".button#submit", target: "/api/checkout", value: 42)
        )
        let json = try encode(event)
        XCTAssertEqual(
            Set(json.keys),
            ["weight", "id", "referer", "checkpoint", "t", "source", "target", "value"]
        )
        XCTAssertEqual(json["weight"] as? Int, 100)
        XCTAssertEqual(json["id"] as? String, "abc123def")
        XCTAssertEqual(json["referer"] as? String, "https://com.example.app/home")
        XCTAssertEqual(json["checkpoint"] as? String, "click")
        XCTAssertEqual(json["t"] as? Int, 1234)
        XCTAssertEqual(json["source"] as? String, ".button#submit")
        XCTAssertEqual(json["target"] as? String, "/api/checkout")
        XCTAssertEqual(json["value"] as? Double, 42)
    }

    func testOmitsAbsentPingDataFields() throws {
        let event = RUMEvent(
            weight: 100,
            id: "xxxxxxxxx",
            referer: "https://com.example.app/",
            checkpoint: .top,
            t: 0
        )
        let json = try encode(event)
        XCTAssertEqual(Set(json.keys), ["weight", "id", "referer", "checkpoint", "t"])
        XCTAssertNil(json["source"])
        XCTAssertNil(json["target"])
        XCTAssertNil(json["value"])
    }

    func testFixtureByteShapeMatchesHelixRumJsPayload() throws {
        // Hand-written fixture mirroring helix-rum-js `sendPing` JSON body for
        // the same event. Comparison is via parsed-JSON shape (key set + values)
        // so it is independent of object-key ordering.
        let event = RUMEvent(
            weight: 100,
            id: "abc123def",
            referer: "https://com.example.app/home",
            checkpoint: .click,
            t: 1234,
            pingData: RUMPingData(source: ".button#submit", target: "/api/checkout", value: 42)
        )
        let actualData = try JSONEncoder().encode(event)
        let fixture = """
        {"weight":100,"id":"abc123def","referer":"https://com.example.app/home",\
        "checkpoint":"click","t":1234,"source":".button#submit",\
        "target":"/api/checkout","value":42}
        """
        let actualObject = try JSONSerialization.jsonObject(with: actualData) as? NSDictionary
        let expectedObject = try JSONSerialization.jsonObject(
            with: Data(fixture.utf8)
        ) as? NSDictionary
        XCTAssertEqual(actualObject, expectedObject)
    }

    func testRawCheckpointPassesThroughInEncodedJSON() throws {
        let event = RUMEvent(
            weight: 100,
            id: "abc123def",
            referer: "https://com.example.app/",
            checkpoint: .raw("custom-cp"),
            t: 1
        )
        let json = try encode(event)
        XCTAssertEqual(json["checkpoint"] as? String, "custom-cp")
    }

    func testPingDataIsEmpty() {
        XCTAssertTrue(RUMPingData().isEmpty)
        XCTAssertFalse(RUMPingData(source: "x").isEmpty)
        XCTAssertFalse(RUMPingData(target: "x").isEmpty)
        XCTAssertFalse(RUMPingData(value: 0).isEmpty)
    }

    func testSessionIDIsNineLowercaseHexCharacters() {
        let hex = CharacterSet(charactersIn: "0123456789abcdef")
        for _ in 0..<32 {
            let sid = RUMSessionID.generate()
            XCTAssertEqual(sid.count, 9, "expected 9-char session id, got \(sid)")
            XCTAssertEqual(sid, sid.lowercased())
            for scalar in sid.unicodeScalars {
                XCTAssertTrue(hex.contains(scalar), "non-hex char in \(sid): \(scalar)")
            }
        }
    }

    func testSessionIDsAreDistinct() {
        let many = (0..<200).map { _ in RUMSessionID.generate() }
        // Collisions across 9 hex chars are extremely unlikely; require >195
        // distinct ids out of 200 to keep the test stable.
        XCTAssertGreaterThan(Set(many).count, 195)
    }
}
