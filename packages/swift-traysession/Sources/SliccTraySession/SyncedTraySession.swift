import CryptoKit
import Foundation







public struct SyncedTraySession: Codable, Equatable, Identifiable {
    
    
    
    
    
    
    public let id: String
    
    
    public var joinUrl: String
    
    public var label: String
    
    
    
    
    public var deviceId: String
    
    
    public var deviceName: String
    public var createdAt: Date
    public var lastSeenAt: Date

    public init(
        joinUrl: String,
        label: String,
        deviceId: String,
        deviceName: String,
        createdAt: Date,
        lastSeenAt: Date
    ) {
        self.id = SyncedTraySession.identifier(forJoinUrl: joinUrl)
        self.joinUrl = joinUrl
        self.label = label
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, joinUrl, label, deviceId, deviceName, createdAt, lastSeenAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        joinUrl = try container.decode(String.self, forKey: .joinUrl)
        label = try container.decode(String.self, forKey: .label)
        
        deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId) ?? ""
        deviceName = try container.decode(String.self, forKey: .deviceName)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        lastSeenAt = try container.decode(Date.self, forKey: .lastSeenAt)
    }

    
    
    public static func identifier(forJoinUrl joinUrl: String) -> String {
        SHA256.hash(data: Data(joinUrl.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    public func isStale(ttl: TimeInterval, now: Date) -> Bool {
        now.timeIntervalSince(lastSeenAt) > ttl
    }
}
