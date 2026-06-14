import Foundation

/// On-the-wire checkpoint name for a RUM event. Mirrors the helix-rum-js
/// enumeration; `raw` carries any future/unknown checkpoint string through
/// without modification.
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

    /// Wire-format string for the checkpoint.
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

/// Optional `source` / `target` / `value` payload for a RUM event. Flattened
/// into the top-level JSON envelope at encode time rather than nested, to
/// match the helix-rum-js wire format (`{ ...pingData }`).
public struct RUMPingData: Hashable, Sendable {
    public var source: String?
    public var target: String?
    public var value: Double?

    public init(source: String? = nil, target: String? = nil, value: Double? = nil) {
        self.source = source
        self.target = target
        self.value = value
    }

    /// `true` when none of `source` / `target` / `value` are set.
    public var isEmpty: Bool {
        source == nil && target == nil && value == nil
    }
}

/// One RUM event ready to be POSTed to the collector. The JSON encoding is
/// byte-compatible with helix-rum-js `sampleRUM.sendPing`:
///
/// ```json
/// { "weight": 100, "id": "abc123def", "referer": "...", "checkpoint": "click",
///   "t": 1234, "source": "...", "target": "...", "value": 42 }
/// ```
///
/// `pingData` is flattened onto the top-level object; absent fields are
/// omitted entirely (not encoded as `null`).
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

/// Generator for the 9-character session id used by helix-rum-js
/// (`crypto.randomUUID().slice(-9)`). The JS implementation lowercases UUIDs,
/// so we lowercase the Swift `UUID().uuidString` (which is uppercase by
/// default) before slicing.
public enum RUMSessionID {
    /// Returns a fresh 9-character session id derived from a v4 UUID.
    public static func generate() -> String {
        let uuid = UUID().uuidString.lowercased()
        return String(uuid.suffix(9))
    }
}
