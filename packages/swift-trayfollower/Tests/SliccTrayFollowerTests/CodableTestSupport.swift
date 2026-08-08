import Foundation

@testable import SliccTrayFollower

/// Shared Codable helpers for the pure-logic round-trip suites.
///
/// Kept `internal` (not `private`) so every test file in the target can share
/// one encoder/decoder pair and the same round-trip semantics.
enum WireCodec {
    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()

    /// Sorted-key encoder for order-independent comparisons. `AnyCodable`'s own
    /// `==` compares raw JSON bytes, so multi-key dictionaries are not stable
    /// across an encode/decode hop; canonicalizing with sorted keys removes that
    /// dependence on Dictionary iteration order.
    static let sortedEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    /// Encode then decode a value back into its own type.
    static func roundTrip<T: Codable>(_ value: T) throws -> T {
        try decoder.decode(T.self, from: encoder.encode(value))
    }

    /// Serialize a value to a JSON string (for shape assertions).
    static func jsonString<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    /// Decode a type from a JSON string literal.
    static func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        try decoder.decode(type, from: Data(json.utf8))
    }

    /// The `type` discriminator an encoded message serializes to.
    static func discriminator<T: Encodable>(_ value: T) throws -> String? {
        let object = try JSONSerialization.jsonObject(with: encoder.encode(value)) as? [String: Any]
        return object?["type"] as? String
    }

    /// Build an `AnyCodable` from a JSON literal so the wrapped value uses the
    /// same `[String: Any?]` / `[Any?]` shapes the decoder produces on the wire.
    static func anyCodable(_ json: String) throws -> AnyCodable {
        try decode(AnyCodable.self, from: json)
    }

    /// Canonical (sorted-key) JSON for an optional `AnyCodable`, for comparisons
    /// that must not depend on Dictionary iteration order.
    static func canonical(_ value: AnyCodable?) throws -> String {
        guard let value else { return "null" }
        return String(decoding: try sortedEncoder.encode(value), as: UTF8.self)
    }
}
