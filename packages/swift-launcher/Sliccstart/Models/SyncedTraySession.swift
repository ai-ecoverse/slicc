import Foundation

/// One tray session advertised for cross-device discovery.
///
/// Foundation-only and platform-agnostic on purpose: the iOS follower
/// (`packages/ios-app`) is expected to reuse this type verbatim once it
/// gains iCloud sync, so nothing here may import AppKit/UIKit.
struct SyncedTraySession: Codable, Equatable, Identifiable {
    /// Stable identifier. Derived from the join URL so a republish (fresh
    /// `lastSeenAt`) upserts in place, and two devices that observe the
    /// same tray collapse to a single entry rather than duplicating.
    let id: String
    /// Full leader join URL (carries the session secret). Threaded into a
    /// follower via `--join=<url>`.
    var joinUrl: String
    /// Human-facing label, e.g. "Chrome on Lars's MacBook".
    var label: String
    /// Name of the device that published the session.
    var deviceName: String
    var createdAt: Date
    var lastSeenAt: Date

    init(
        joinUrl: String,
        label: String,
        deviceName: String,
        createdAt: Date,
        lastSeenAt: Date
    ) {
        self.id = SyncedTraySession.identifier(forJoinUrl: joinUrl)
        self.joinUrl = joinUrl
        self.label = label
        self.deviceName = deviceName
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
    }

    /// The join URL is globally unique per tray session, so it doubles as
    /// the identity key. Kept behind a function so the derivation can
    /// change (e.g. to a hash) without touching call sites.
    static func identifier(forJoinUrl joinUrl: String) -> String {
        joinUrl
    }

    func isStale(ttl: TimeInterval, now: Date) -> Bool {
        now.timeIntervalSince(lastSeenAt) > ttl
    }
}
