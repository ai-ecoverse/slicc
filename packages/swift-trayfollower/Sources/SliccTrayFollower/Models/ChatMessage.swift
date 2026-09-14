import Foundation




public struct AnyCodable: Codable, Equatable {
    public let value: Any?

    public init(_ value: Any?) {
        
        
        
        
        
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
        
        if lhs.value == nil && rhs.value == nil { return true }
        guard let lData = try? JSONEncoder().encode(lhs),
            let rData = try? JSONEncoder().encode(rhs)
        else { return false }
        return lData == rData
    }
}



public enum MessageRole: String, Codable {
    case user
    case assistant
}

















public enum MessageAttachmentKind: String, Codable {
    case image
    case text
    case file

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MessageAttachmentKind(rawValue: raw) ?? .file
    }
}


public struct MessageAttachment: Codable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let mimeType: String
    public let size: Int
    public let kind: MessageAttachmentKind
    
    public var data: String?
    
    public var text: String?
    
    public var path: String?
    
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






public struct ToolProgressEvent: Codable, Hashable {
    
    public let id: String
    
    public let label: String
    
    public let fraction: Double?
    
    public let etaMs: Double?
    
    public let done: Double?
    public let total: Double?
    
    
    
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




public enum ToolProgressPhase: String, Codable {
    case start
    case update
    case end

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ToolProgressPhase(rawValue: raw) ?? .update
    }
}







public enum LickState: String, Codable {
    case pending
    case confirmed
    case dismissed

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LickState(rawValue: raw) ?? .pending
    }
}







public enum CompactionMarkerTrigger: String, Codable {
    case threshold
    case overflow
    case idle

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CompactionMarkerTrigger(rawValue: raw) ?? .threshold
    }
}








public enum CompactionMarkerState: String, Codable {
    case summarizing
    case summarized
    case fallback
    case discarded

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CompactionMarkerState(rawValue: raw) ?? .summarized
    }
}








public struct ChatCompactionMarker: Codable, Equatable {
    public var trigger: CompactionMarkerTrigger
    public var state: CompactionMarkerState
    
    public var transcriptPath: String?

    public init(
        trigger: CompactionMarkerTrigger,
        state: CompactionMarkerState,
        transcriptPath: String? = nil
    ) {
        self.trigger = trigger
        self.state = state
        self.transcriptPath = transcriptPath
    }
}



public struct ToolCall: Codable, Identifiable, Equatable {
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








public struct ChatMessage: Codable, Identifiable, Equatable {
    public let id: String
    public let role: MessageRole
    public var content: String
    public let timestamp: Double  
    public var attachments: [MessageAttachment]?
    public var toolCalls: [ToolCall]?
    public var isStreaming: Bool?
    
    public var model: String?
    
    public var usage: ChatMessageUsage?
    public var source: String?  
    public var channel: String?  
    
    public var lickCount: Int?
    
    public var lickParts: [String]?
    
    
    var lickId: String?
    public var lickState: LickState?
    public var queued: Bool?
    
    
    public var error: Bool?
    
    
    public var compaction: ChatCompactionMarker?

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
        error: Bool? = nil,
        compaction: ChatCompactionMarker? = nil
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
        self.compaction = compaction
    }
}
