import Foundation
import XCTest

@testable import SliccTrayFollower

/// `AnyCodable` is the wire's escape hatch for arbitrary JSON. These exercise
/// every branch of its `init(from:)` / `encode(to:)` switches plus the
/// wrapped-value flattening in the memberwise init and the JSON-based `==`.
final class AnyCodableTests: XCTestCase {

    /// Decode a JSON literal, re-encode, and assert the content survives the
    /// round-trip. Compared in canonical (sorted-key) form so the check does not
    /// depend on Dictionary iteration order.
    private func assertStable(_ json: String) throws {
        let decoded = try WireCodec.decode(AnyCodable.self, from: json)
        let reencoded = try WireCodec.jsonString(decoded)
        let redecoded = try WireCodec.decode(AnyCodable.self, from: reencoded)
        XCTAssertEqual(try WireCodec.canonical(decoded), try WireCodec.canonical(redecoded))
    }

    func testNilRoundTrip() throws {
        let decoded = try WireCodec.decode(AnyCodable.self, from: "null")
        XCTAssertNil(decoded.value)
        XCTAssertEqual(try WireCodec.jsonString(decoded), "null")
    }

    func testBoolRoundTrip() throws {
        let decoded = try WireCodec.decode(AnyCodable.self, from: "true")
        XCTAssertEqual(decoded.value as? Bool, true)
        XCTAssertEqual(try WireCodec.jsonString(decoded), "true")
    }

    func testIntRoundTrip() throws {
        let decoded = try WireCodec.decode(AnyCodable.self, from: "42")
        XCTAssertEqual(decoded.value as? Int, 42)
        XCTAssertEqual(try WireCodec.jsonString(decoded), "42")
    }

    func testDoubleRoundTrip() throws {
        let decoded = try WireCodec.decode(AnyCodable.self, from: "3.5")
        XCTAssertEqual(decoded.value as? Double, 3.5)
        XCTAssertEqual(try WireCodec.jsonString(decoded), "3.5")
    }

    func testStringRoundTrip() throws {
        let decoded = try WireCodec.decode(AnyCodable.self, from: #""hello""#)
        XCTAssertEqual(decoded.value as? String, "hello")
        XCTAssertEqual(try WireCodec.jsonString(decoded), #""hello""#)
    }

    func testArrayRoundTrip() throws {
        let decoded = try WireCodec.decode(AnyCodable.self, from: #"[1,"two",true,null]"#)
        let array = try XCTUnwrap(decoded.value as? [Any?])
        XCTAssertEqual(array.count, 4)
        XCTAssertEqual(array[0] as? Int, 1)
        XCTAssertEqual(array[1] as? String, "two")
        XCTAssertEqual(array[2] as? Bool, true)
        try assertStable(#"[1,"two",true,null]"#)
    }

    func testDictionaryRoundTrip() throws {
        let decoded = try WireCodec.decode(AnyCodable.self, from: #"{"a":1,"b":"x","c":false}"#)
        let dict = try XCTUnwrap(decoded.value as? [String: Any?])
        XCTAssertEqual(dict["a"] as? Int, 1)
        XCTAssertEqual(dict["b"] as? String, "x")
        XCTAssertEqual(dict["c"] as? Bool, false)
        try assertStable(#"{"a":1,"b":"x","c":false}"#)
    }

    func testNestedStructureRoundTrip() throws {
        let json = #"{"outer":{"list":[1,2,{"deep":true}],"flag":null}}"#
        try assertStable(json)
        let decoded = try WireCodec.decode(AnyCodable.self, from: json)
        let outer = try XCTUnwrap(decoded.value as? [String: Any?])
        let inner = try XCTUnwrap(outer["outer"] as? [String: Any?])
        let list = try XCTUnwrap(inner["list"] as? [Any?])
        XCTAssertEqual(list.count, 3)
    }

    func testWrappedValueIsFlattenedOnInit() throws {
        // A nested AnyCodable used to survive construction and encode as null.
        let inner = AnyCodable(7)
        let outer = AnyCodable(inner)
        XCTAssertEqual(outer.value as? Int, 7)
        XCTAssertEqual(try WireCodec.jsonString(outer), "7")
    }

    func testEqualityForMatchingValues() {
        XCTAssertEqual(AnyCodable(nil), AnyCodable(nil))
        XCTAssertEqual(AnyCodable("x"), AnyCodable("x"))
        XCTAssertEqual(AnyCodable(1), AnyCodable(1))
    }

    func testEqualityForMismatchedValues() {
        XCTAssertNotEqual(AnyCodable("x"), AnyCodable("y"))
        XCTAssertNotEqual(AnyCodable(nil), AnyCodable("x"))
        XCTAssertNotEqual(AnyCodable(1), AnyCodable(2))
    }

    func testUnsupportedValueEncodesAsNull() throws {
        // A value outside the supported set falls through to `encodeNil`.
        let encoded = try WireCodec.jsonString(AnyCodable(Date()))
        XCTAssertEqual(encoded, "null")
    }
}
