import Foundation










public struct WidgetSnapshot: Codable, Hashable, Sendable {
    
    public enum Connection: String, Codable, Sendable {
        
        case connected
        
        
        
        case stalled
        
        case disconnected
        
        case none
    }

    
    
    public static let currentSchema = 1

    public let schema: Int
    
    public let instanceLabel: String
    
    
    public let runtime: String?
    public let connection: Connection
    
    public let capturedAt: Date
    
    public let units: [WidgetUnit]
    
    
    
    public let lastMessage: WidgetMessage?

    public init(
        schema: Int = WidgetSnapshot.currentSchema,
        instanceLabel: String,
        runtime: String? = nil,
        connection: Connection,
        capturedAt: Date,
        units: [WidgetUnit],
        lastMessage: WidgetMessage? = nil
    ) {
        self.schema = schema
        self.instanceLabel = instanceLabel
        self.runtime = runtime
        self.connection = connection
        self.capturedAt = capturedAt
        self.units = units
        self.lastMessage = lastMessage
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decodeIfPresent(Int.self, forKey: .schema) ?? Self.currentSchema
        instanceLabel = try container.decodeIfPresent(String.self, forKey: .instanceLabel) ?? "SLICC"
        runtime = try container.decodeIfPresent(String.self, forKey: .runtime)
        connection =
            Connection(rawValue: try container.decodeIfPresent(String.self, forKey: .connection) ?? "")
            ?? .none
        capturedAt = try container.decodeIfPresent(Date.self, forKey: .capturedAt) ?? Date(timeIntervalSince1970: 0)
        units = try container.decodeIfPresent([WidgetUnit].self, forKey: .units) ?? []
        lastMessage = try container.decodeIfPresent(WidgetMessage.self, forKey: .lastMessage)
    }
}

extension WidgetSnapshot {
    
    
    
    public static func unavailable(reason: Connection = .none) -> WidgetSnapshot {
        WidgetSnapshot(
            instanceLabel: "SLICC",
            runtime: nil,
            connection: reason,
            capturedAt: Date(timeIntervalSince1970: 0),
            units: [],
            lastMessage: nil
        )
    }

    
    
    
    public var primaryCone: WidgetUnit? {
        let roots = units.filter { $0.role == .cone }
        return roots.first(where: \.isActive) ?? roots.first
    }

    public var scoops: [WidgetUnit] { units.filter { $0.role == .scoop } }

    
    
    public func scoops(ownedBy unit: WidgetUnit) -> [WidgetUnit] {
        let owned = units.filter { $0.parentId == unit.id }
        return owned.isEmpty ? scoops.filter { $0.parentId == nil } : owned
    }

    public var busyCount: Int { units.filter(\.isBusy).count }

    
    
    public var brokenCount: Int { units.filter { $0.lifecycle == .broken }.count }

    
    
    
    
    
    
    
    
    
    public var isUnavailable: Bool {
        units.isEmpty && connection != .connected
    }

    
    
    
    
    public static let stalenessHorizon: TimeInterval = 15 * 60

    public func isStale(asOf now: Date) -> Bool {
        connection != .connected || now.timeIntervalSince(capturedAt) > Self.stalenessHorizon
    }
}






public struct WidgetMessage: Codable, Hashable, Sendable {
    public enum Author: String, Codable, Sendable {
        case agent
        case user
    }

    
    
    public static let previewLimit = 280

    public let author: Author
    
    
    public let unitId: String?
    public let text: String
    
    
    public let at: Date?

    public init(author: Author, unitId: String? = nil, text: String, at: Date? = nil) {
        self.author = author
        self.unitId = unitId
        self.text = String(text.prefix(Self.previewLimit))
        self.at = at
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        author =
            Author(rawValue: try container.decodeIfPresent(String.self, forKey: .author) ?? "")
            ?? .agent
        unitId = try container.decodeIfPresent(String.self, forKey: .unitId)
        text = String((try container.decodeIfPresent(String.self, forKey: .text) ?? "").prefix(Self.previewLimit))
        at = try container.decodeIfPresent(Date.self, forKey: .at)
    }
}

extension WidgetMessage {
    
    
    
    
    
    
    
    
    
    
    
    public static func flatten(markdown: String) -> String {
        var text = markdown

        
        
        text = text.replacingOccurrences(
            of: "```[\\s\\S]*?```", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(
            of: "`([^`]*)`", with: "$1", options: .regularExpression)
        
        text = text.replacingOccurrences(
            of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(
            of: "\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        
        text = text.replacingOccurrences(
            of: "(?m)^\\s{0,3}(#{1,6}\\s+|>\\s?|[-*+]\\s+|\\d+\\.\\s+)", with: "",
            options: .regularExpression)
        text = text.replacingOccurrences(
            of: "(?m)^\\s*([-*_])\\s*\\1\\s*\\1[-*_\\s]*$", with: " ",
            options: .regularExpression)
        
        text = text.replacingOccurrences(
            of: "(\\*\\*|__|\\*|_|~~)", with: "", options: .regularExpression)
        text = text.replacingOccurrences(
            of: "\\s+", with: " ", options: .regularExpression)

        return String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(previewLimit))
    }
}

extension WidgetSnapshot {
    
    public var lastMessageUnit: WidgetUnit? {
        guard let id = lastMessage?.unitId else { return nil }
        return units.first { $0.id == id }
    }
}
