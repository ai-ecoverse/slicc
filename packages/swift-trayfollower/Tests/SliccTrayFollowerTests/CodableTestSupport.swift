import Foundation

@testable import SliccTrayFollower

enum WireCodec {
    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()

    static let sortedEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    static func roundTrip<T: Codable>(_ value: T) throws -> T {
        try decoder.decode(T.self, from: encoder.encode(value))
    }

    static func jsonString<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    static func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        try decoder.decode(type, from: Data(json.utf8))
    }

    static func discriminator<T: Encodable>(_ value: T) throws -> String? {
        let object = try JSONSerialization.jsonObject(with: encoder.encode(value)) as? [String: Any]
        return object?["type"] as? String
    }

    static func anyCodable(_ json: String) throws -> AnyCodable {
        try decode(AnyCodable.self, from: json)
    }

    static func canonical(_ value: AnyCodable?) throws -> String {
        guard let value else { return "null" }
        return String(decoding: try sortedEncoder.encode(value), as: UTF8.self)
    }
}
