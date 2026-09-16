import Foundation

public enum RUMCheckpoint: Hashable, Sendable {
    case top
    case enter
    case navigate
    case reload
    case cwv
    case pagesviewed
    case click
    case viewblock
    case viewmedia
    case formsubmit
    case error
    case raw(String)

    public var rawValue: String {
        switch self {
        case .top: return "top"
        case .enter: return "enter"
        case .navigate: return "navigate"
        case .reload: return "reload"
        case .cwv: return "cwv"
        case .pagesviewed: return "pagesviewed"
        case .click: return "click"
        case .viewblock: return "viewblock"
        case .viewmedia: return "viewmedia"
        case .formsubmit: return "formsubmit"
        case .error: return "error"
        case .raw(let value): return value
        }
    }
}

public struct RUMPingData: Hashable, Sendable {
    public var source: String?
    public var target: String?
    public var value: Double?

    public init(source: String? = nil, target: String? = nil, value: Double? = nil) {
        self.source = source
        self.target = target
        self.value = value
    }

    public var isEmpty: Bool {
        source == nil && target == nil && value == nil
    }
}

public struct RUMEvent: Hashable, Sendable {
    public var weight: Int
    public var id: String
    public var referer: String
    public var checkpoint: RUMCheckpoint
    public var t: Int
    public var pingData: RUMPingData

    public init(
        weight: Int,
        id: String,
        referer: String,
        checkpoint: RUMCheckpoint,
        t: Int,
        pingData: RUMPingData = RUMPingData()
    ) {
        self.weight = weight
        self.id = id
        self.referer = referer
        self.checkpoint = checkpoint
        self.t = t
        self.pingData = pingData
    }
}

extension RUMEvent: Encodable {
    private enum CodingKeys: String, CodingKey {
        case weight, id, referer, checkpoint, t, source, target, value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(weight, forKey: .weight)
        try container.encode(id, forKey: .id)
        try container.encode(referer, forKey: .referer)
        try container.encode(checkpoint.rawValue, forKey: .checkpoint)
        try container.encode(t, forKey: .t)
        try container.encodeIfPresent(pingData.source, forKey: .source)
        try container.encodeIfPresent(pingData.target, forKey: .target)
        try container.encodeIfPresent(pingData.value, forKey: .value)
    }
}

public enum RUMSessionID {

    public static func generate() -> String {
        let uuid = UUID().uuidString.lowercased()
        return String(uuid.suffix(9))
    }
}
