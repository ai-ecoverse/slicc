import Foundation
import SliccTraySession

/// Presentation logic for the Settings "iCloud Sessions" list, kept out of
/// the view so grouping, ordering, and the empty-state decision are unit
/// testable without SwiftUI or iCloud.
enum ICloudSessionList {
    /// One publishing device's sessions, newest-first. Grouping keys on
    /// `deviceId` — two Macs may share a host name — while the header shows
    /// `deviceName`.
    struct DeviceGroup: Equatable, Identifiable {
        let deviceId: String
        let deviceName: String
        let sessions: [SyncedTraySession]
        var id: String { deviceId }
    }

    /// Groups the store's (already newest-first, already TTL-pruned) sessions
    /// by publishing device. Devices keep the order of their newest session,
    /// so the most recently active Mac sorts first.
    static func groups(from sessions: [SyncedTraySession]) -> [DeviceGroup] {
        var order: [String] = []
        var byDevice: [String: [SyncedTraySession]] = [:]
        for session in sessions {
            if byDevice[session.deviceId] == nil { order.append(session.deviceId) }
            byDevice[session.deviceId, default: []].append(session)
        }
        return order.compactMap { id in
            guard let sessions = byDevice[id], let first = sessions.first else { return nil }
            let name = first.deviceName.isEmpty ? "Unknown device" : first.deviceName
            return DeviceGroup(deviceId: id, deviceName: name, sessions: sessions)
        }
    }

    /// Why the list is empty — the two cases need different guidance. Signed
    /// out of iCloud is user-fixable on the phone; "no sessions" means no Mac
    /// on this Apple ID is currently advertising a leader. (An unprovisioned
    /// dev build is indistinguishable from the latter at runtime: the KVS
    /// degrades silently to an empty local cache.)
    enum EmptyReason: Equatable {
        case iCloudUnavailable
        case noSessions
    }

    static func emptyReason(hasICloudIdentity: Bool) -> EmptyReason {
        hasICloudIdentity ? .noSessions : .iCloudUnavailable
    }

    /// Compact relative age for a session row ("2m ago"). Mirrors the macOS
    /// launcher's `TraySessionRow.age` thresholds so both platforms describe
    /// the same session the same way.
    static func age(of date: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h ago" }
        return "\(Int(seconds / 86_400))d ago"
    }
}
