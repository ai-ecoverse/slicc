import Foundation










public struct WidgetUnit: Codable, Identifiable, Hashable, Sendable {
    
    public enum Role: String, Codable, Sendable {
        case cone
        case scoop
    }

    
    
    public enum Lifecycle: String, Codable, CaseIterable, Sendable {
        case working
        case broken
        case initializing
        case idle
        case unknown
    }

    
    
    public enum Activity: String, Codable, CaseIterable, Sendable {
        
        case thinking
        
        case tool
        
        case awaiting
    }

    
    public let id: String
    
    public let name: String
    public let role: Role
    
    public let parentId: String?
    public let lifecycle: Lifecycle
    public let activity: Activity?
    
    public let fill: Double?
    
    public let model: String?
    
    
    
    
    public let detail: String?
    
    public let isActive: Bool
    
    
    
    
    
    
    
    public let lastActivityAt: Date?

    public init(
        id: String,
        name: String,
        role: Role,
        parentId: String? = nil,
        lifecycle: Lifecycle = .unknown,
        activity: Activity? = nil,
        fill: Double? = nil,
        model: String? = nil,
        detail: String? = nil,
        isActive: Bool = false,
        lastActivityAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.parentId = parentId
        self.lifecycle = lifecycle
        self.activity = activity
        self.fill = fill.map { $0.isFinite ? min(100, max(0, $0)) : 0 }
        self.model = model
        self.detail = detail
        self.isActive = isActive
        self.lastActivityAt = lastActivityAt
    }

    
    
    
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        role = Role(rawValue: try container.decode(String.self, forKey: .role)) ?? .scoop
        parentId = try container.decodeIfPresent(String.self, forKey: .parentId)
        lifecycle =
            Lifecycle(rawValue: try container.decodeIfPresent(String.self, forKey: .lifecycle) ?? "")
            ?? .unknown
        activity = Activity(rawValue: try container.decodeIfPresent(String.self, forKey: .activity) ?? "")
        fill = try container.decodeIfPresent(Double.self, forKey: .fill)
            .map { $0.isFinite ? min(100, max(0, $0)) : 0 }
        model = try container.decodeIfPresent(String.self, forKey: .model)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        isActive = try container.decodeIfPresent(Bool.self, forKey: .isActive) ?? false
        lastActivityAt = try container.decodeIfPresent(Date.self, forKey: .lastActivityAt)
    }
}

extension WidgetUnit {
    
    
    public static let nearLimitThreshold = 75.0

    public var isNearLimit: Bool { (fill ?? 0) >= Self.nearLimitThreshold }

    
    
    public var isBusy: Bool { lifecycle == .working || lifecycle == .initializing }

    
    
    
    
    
    
    
    
    public var isDormant: Bool {
        (lifecycle == .idle && activity != .awaiting) || lifecycle == .unknown
    }

    
    
    public var statusWord: String {
        switch (lifecycle, activity) {
        case (.working, .tool): "running a tool"
        case (.working, _): "thinking"
        case (.initializing, _): "starting"
        case (.broken, _): "needs you"
        case (.idle, .awaiting): "your turn"
        case (.idle, _): "idle"
        case (.unknown, _): "unknown"
        }
    }

    
    
    
    
    public var shortStatusWord: String {
        lifecycle == .working && activity == .tool ? "tool" : statusWord
    }

    
    
    var activityFingerprint: String {
        "\(lifecycle.rawValue)|\(activity?.rawValue ?? "-")|\(fill.map { String(Int($0)) } ?? "-")"
    }

    
    
    
    
    
    
    
    public var avatarColorHex: String {
        if role == .cone { return "#b07823" }
        let palette = ["#06b6d4", "#8b5cf6", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"]
        let hash = name.unicodeScalars.reduce(UInt32.zero) { hash, scalar in
            let firstCodeUnit: UInt32 =
                scalar.value <= 0xFFFF
                ? scalar.value
                : 0xD800 + ((scalar.value - 0x10000) >> 10)
            return hash &* 31 &+ firstCodeUnit
        }
        return palette[Int(hash % UInt32(palette.count))]
    }

    
    public func accessibilityPhrase() -> String {
        let kind = role == .cone ? "Cone" : "Scoop"
        let fillPhrase = fill.map { ", \(Int($0.rounded())) percent context" } ?? ""
        return "\(kind) \(name), \(statusWord)\(fillPhrase)"
    }
}
