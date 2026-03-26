import Foundation

// MARK: - AnyCodable

/// Minimal wrapper for arbitrary JSON values (String, Int, Double, Bool, Array, Dictionary, null).
struct AnyCodable: Codable, Equatable {
    let value: Any?

    init(_ value: Any?) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = nil
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            value = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        guard let value = value else {
            try container.encodeNil()
            return
        }
        switch value {
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any?]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any?]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Simple equality: both nil, or both encode to the same JSON
        if lhs.value == nil && rhs.value == nil { return true }
        guard let lData = try? JSONEncoder().encode(lhs),
              let rData = try? JSONEncoder().encode(rhs) else { return false }
        return lData == rData
    }
}

// MARK: - MessageRole

enum MessageRole: String, Codable {
    case user
    case assistant
}

// MARK: - ToolCall

struct ToolCall: Codable, Identifiable {
    let id: String
    let name: String
    let input: AnyCodable?
    var result: String?
    var isError: Bool?
}

// MARK: - ChatMessage

struct ChatMessage: Codable, Identifiable {
    let id: String
    let role: MessageRole
    var content: String
    let timestamp: Double  // Unix ms
    var toolCalls: [ToolCall]?
    var isStreaming: Bool?
    var source: String?    // "cone", "lick", scoop name
    var channel: String?   // "webhook", "cron"
    var queued: Bool?
}

