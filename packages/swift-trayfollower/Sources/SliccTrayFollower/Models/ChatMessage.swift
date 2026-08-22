import Foundation

// MARK: - AnyCodable

/// Minimal wrapper for arbitrary JSON values (String, Int, Double, Bool, Array, Dictionary, null).
public struct AnyCodable: Codable, Equatable {
    public let value: Any?

    public init(_ value: Any?) {
        // Flatten an already-wrapped value. Nesting used to survive
        // construction and then encode as `null`, because `encode(to:)`
        // switches on concrete types and an `AnyCodable` payload falls to the
        // `default:` branch — silent data loss at the wire boundary rather
        // than a compile error.
        if let wrapped = value as? AnyCodable {
            self.value = wrapped.value
        } else {
            self.value = value
        }
    }

    public init(from decoder: Decoder) throws {
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

    public func encode(to encoder: Encoder) throws {
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

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Simple equality: both nil, or both encode to the same JSON
        if lhs.value == nil && rhs.value == nil { return true }
        guard let lData = try? JSONEncoder().encode(lhs),
            let rData = try? JSONEncoder().encode(rhs)
        else { return false }
        return lData == rData
    }
}

// MARK: - MessageRole

public enum MessageRole: String, Codable {
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
public enum MessageAttachmentKind: String, Codable {
    case image
    case text
    case file

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MessageAttachmentKind(rawValue: raw) ?? .file
    }
}

/// Mirrors `MessageAttachment` from agent-wire-types.ts.
public struct MessageAttachment: Codable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let mimeType: String
    public let size: Int
    public let kind: MessageAttachmentKind
    /// Base64 payload for LLM-supported image attachments.
    public var data: String?
    /// UTF-8 content for text-like file attachments.
    public var text: String?
    /// VFS path when the file was too large to inline.
    public var path: String?
    /// Human-readable reason the payload could not be included.
    public var error: String?

    public init(
        id: String,
        name: String,
        mimeType: String,
        size: Int,
        kind: MessageAttachmentKind,
        data: String? = nil,
        text: String? = nil,
        path: String? = nil,
        error: String? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.size = size
        self.kind = kind
        self.data = data
        self.text = text
        self.path = path
        self.error = error
    }
}

// MARK: - Usage

/// Mirrors `ChatMessageUsage['cost']` from agent-wire-types.ts.
public struct ChatMessageCost: Codable, Hashable {
    public let input: Double
    public let output: Double
    let cacheRead: Double
    let cacheWrite: Double
    public let total: Double

    public init(input: Double, output: Double, cacheRead: Double, cacheWrite: Double, total: Double) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.total = total
    }
}

/// Mirrors `ChatMessageUsage` from agent-wire-types.ts. Carried for cost
/// attribution; the leader reports it once the provider closes the turn.
public struct ChatMessageUsage: Codable, Hashable {
    public let input: Int
    public let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    public let cost: ChatMessageCost

    public init(input: Int, output: Int, cacheRead: Int, cacheWrite: Int, cost: ChatMessageCost) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.cost = cost
    }
}

// MARK: - ToolProgressEvent

/// Mirrors `ToolProgressEvent` from `packages/shared-ts/src/agent-wire-types.ts`
/// — one live progress unit for a running tool call (the bash overlay, #2282).
/// Ticks arrive up to ~4/s per unit, so keep this cheap to decode.
public struct ToolProgressEvent: Codable, Hashable {
    /// Stable id per running unit (command invocation or loop).
    public let id: String
    /// Human label: "sleep 30", "curl …/big.tar.gz", "for (3 of 12)".
    public let label: String
    /// 0..1 when determinate; `nil` means an indeterminate unit.
    public let fraction: Double?
    /// Best-effort remaining ms; `nil` when unknown.
    public let etaMs: Double?
    /// Optional unit counters, e.g. bytes or iterations.
    public let done: Double?
    public let total: Double?
    /// `bytes`, `iterations` or `ms` on the wire. Kept as a raw string: the
    /// follower only branches on `iterations`, and an unknown unit from a newer
    /// leader must not fail the decode of the whole agent event.
    public let unit: String?
    public let phase: ToolProgressPhase

    public init(
        id: String, label: String, fraction: Double? = nil, etaMs: Double? = nil,
        done: Double? = nil, total: Double? = nil, unit: String? = nil,
        phase: ToolProgressPhase = .update
    ) {
        self.id = id
        self.label = label
        self.fraction = fraction
        self.etaMs = etaMs
        self.done = done
        self.total = total
        self.unit = unit
        self.phase = phase
    }
}

/// Lifecycle of a progress unit. Lenient like `LickState` — an unrecognized
/// phase reads as `.update`, which keeps the treatment on screen rather than
/// tearing it down on a value a newer leader invented.
public enum ToolProgressPhase: String, Codable {
    case start
    case update
    case end

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ToolProgressPhase(rawValue: raw) ?? .update
    }
}

// MARK: - LickState

/// Mirrors `LickState` from agent-wire-types.ts: the settled result of an
/// actionable lick card. Lenient for the same reason as
/// `MessageAttachmentKind`, and lossy on re-encode in the same way: an unknown
/// state must not empty a snapshot, so it degrades to `.pending`.
public enum LickState: String, Codable {
    case pending
    case confirmed
    case dismissed

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LickState(rawValue: raw) ?? .pending
    }
}

// MARK: - ToolCall

public struct ToolCall: Codable, Identifiable {
    public let id: String
    public let name: String
    public let input: AnyCodable?
    public var result: String?
    public var isError: Bool?

    public init(
        id: String, name: String, input: AnyCodable?, result: String? = nil, isError: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.input = input
        self.result = result
        self.isError = isError
    }
}

// MARK: - ChatMessage

public struct ChatMessage: Codable, Identifiable {
    public let id: String
    public let role: MessageRole
    public var content: String
    public let timestamp: Double  // Unix ms
    public var attachments: [MessageAttachment]?
    public var toolCalls: [ToolCall]?
    public var isStreaming: Bool?
    /// Assistant model id, retained for cost attribution.
    public var model: String?
    /// Final assistant usage, present once the provider reports the turn.
    public var usage: ChatMessageUsage?
    public var source: String?  // "cone", "lick", scoop name
    public var channel: String?  // "webhook", "cron"
    /// How many consecutive same-channel licks this row stands for.
    public var lickCount: Int?
    /// The individual lick bodies folded into this row.
    public var lickParts: [String]?
    /// Orchestrator-minted id of an actionable lick, used to locate this card
    /// when its decision settles so the state can flip live.
    var lickId: String?
    public var lickState: LickState?
    public var queued: Bool?
    /// Cone-error marker. The message is an error report rather than an
    /// ordinary assistant turn.
    public var error: Bool?

    public init(
        id: String,
        role: MessageRole,
        content: String,
        timestamp: Double,
        attachments: [MessageAttachment]? = nil,
        toolCalls: [ToolCall]? = nil,
        isStreaming: Bool? = nil,
        model: String? = nil,
        usage: ChatMessageUsage? = nil,
        source: String? = nil,
        channel: String? = nil,
        lickCount: Int? = nil,
        lickParts: [String]? = nil,
        lickId: String? = nil,
        lickState: LickState? = nil,
        queued: Bool? = nil,
        error: Bool? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.attachments = attachments
        self.toolCalls = toolCalls
        self.isStreaming = isStreaming
        self.model = model
        self.usage = usage
        self.source = source
        self.channel = channel
        self.lickCount = lickCount
        self.lickParts = lickParts
        self.lickId = lickId
        self.lickState = lickState
        self.queued = queued
        self.error = error
    }
}
