import CryptoKit
import Foundation

/// One tray session advertised for cross-device discovery.
///
/// Foundation-only and platform-agnostic on purpose: the iOS follower
/// (`packages/ios-app`) is expected to reuse this type verbatim once it
/// gains iCloud sync, so nothing here may import AppKit/UIKit. (CryptoKit is
/// available on both macOS and iOS.)
struct SyncedTraySession: Codable, Equatable, Identifiable {
    /// Stable, opaque identifier: the SHA-256 of the join URL. Derived from
    /// the join URL so a republish (fresh `lastSeenAt`) upserts in place and
    /// two devices observing the same tray collapse to one entry — but it is
    /// a one-way hash, so it can be used in accessibility identifiers /
    /// telemetry `source` strings without leaking the session secret the raw
    /// join URL carries.
    let id: String
    /// Full leader join URL (carries the session secret). Threaded into a
    /// follower via `--join=<url>`. Never surfaced to telemetry.
    var joinUrl: String
    /// Human-facing label, e.g. "Chrome on Lars's MacBook".
    var label: String
    /// Stable per-device identity (a persisted UUID) of the publisher. Used
    /// for ownership (local vs remote) so two Macs sharing a host name do not
    /// collide. Empty only for legacy payloads decoded before this field
    /// existed.
    var deviceId: String
    /// Human-facing name of the device that published the session (display
    /// only — ownership keys on `deviceId`).
    var deviceName: String
    var createdAt: Date
    var lastSeenAt: Date

    init(
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

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        joinUrl = try container.decode(String.self, forKey: .joinUrl)
        label = try container.decode(String.self, forKey: .label)
        // Tolerate payloads published before `deviceId` existed.
        deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId) ?? ""
        deviceName = try container.decode(String.self, forKey: .deviceName)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        lastSeenAt = try container.decode(Date.self, forKey: .lastSeenAt)
    }

    /// SHA-256 hex of the join URL. Kept behind a function so the derivation
    /// stays in one place and every call site agrees on the identity key.
    static func identifier(forJoinUrl joinUrl: String) -> String {
        SHA256.hash(data: Data(joinUrl.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    func isStale(ttl: TimeInterval, now: Date) -> Bool {
        now.timeIntervalSince(lastSeenAt) > ttl
    }
}
