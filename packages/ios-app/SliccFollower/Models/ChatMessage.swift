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
            let rData = try? JSONEncoder().encode(rhs)
        else { return false }
        return lData == rData
    }
}

// MARK: - MessageRole

enum MessageRole: String, Codable {
    case user
    case assistant
}

// MARK: - MessageAttachment

/// Mirrors `MessageAttachmentKind` from agent-wire-types.ts.
///
/// Decoding is lenient on purpose. `ChatMessage` arrays arrive inside
/// `snapshot`, which decodes them with `try? … ?? []` — so one unrecognized
/// kind string would not surface as an error, it would silently empty the
/// whole transcript. An unknown kind degrades to `.file`, the neutral
/// icon-only presentation, instead.
///
/// The fallback is lossy on re-encode: an unknown tag becomes `"file"` rather
/// than round-tripping. That is invisible today because iOS only ever decodes
/// `ChatMessage` — it never re-broadcasts one — and the corpus cannot catch it
/// either, since its samples use known values. Preserving the original tag
/// would need a sidecar field; only worth it if a follower ever re-emits a
/// transcript.
enum MessageAttachmentKind: String, Codable {
    case image
    case text
    case file

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MessageAttachmentKind(rawValue: raw) ?? .file
    }
}

/// Mirrors `MessageAttachment` from agent-wire-types.ts.
struct MessageAttachment: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let mimeType: String
    let size: Int
    let kind: MessageAttachmentKind
    /// Base64 payload for LLM-supported image attachments.
    var data: String?
    /// UTF-8 content for text-like file attachments.
    var text: String?
    /// VFS path when the file was too large to inline.
    var path: String?
    /// Human-readable reason the payload could not be included.
    var error: String?
}

// MARK: - Usage

/// Mirrors `ChatMessageUsage['cost']` from agent-wire-types.ts.
struct ChatMessageCost: Codable, Hashable {
    let input: Double
    let output: Double
    let cacheRead: Double
    let cacheWrite: Double
    let total: Double
}

/// Mirrors `ChatMessageUsage` from agent-wire-types.ts. Carried for cost
/// attribution; the leader reports it once the provider closes the turn.
struct ChatMessageUsage: Codable, Hashable {
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let cost: ChatMessageCost
}

// MARK: - LickState

/// Mirrors `LickState` from agent-wire-types.ts: the settled result of an
/// actionable lick card. Lenient for the same reason as
/// `MessageAttachmentKind`, and lossy on re-encode in the same way: an unknown
/// state must not empty a snapshot, so it degrades to `.pending`.
enum LickState: String, Codable {
    case pending
    case confirmed
    case dismissed

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LickState(rawValue: raw) ?? .pending
    }
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
    var attachments: [MessageAttachment]?
    var toolCalls: [ToolCall]?
    var isStreaming: Bool?
    /// Assistant model id, retained for cost attribution.
    var model: String?
    /// Final assistant usage, present once the provider reports the turn.
    var usage: ChatMessageUsage?
    var source: String?  // "cone", "lick", scoop name
    var channel: String?  // "webhook", "cron"
    /// How many consecutive same-channel licks this row stands for.
    var lickCount: Int?
    /// The individual lick bodies folded into this row.
    var lickParts: [String]?
    /// Orchestrator-minted id of an actionable lick, used to locate this card
    /// when its decision settles so the state can flip live.
    var lickId: String?
    var lickState: LickState?
    var queued: Bool?
    /// Cone-error marker. The message is an error report rather than an
    /// ordinary assistant turn.
    var error: Bool?
}
