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

/// Presentation logic for the "Recent" list — join URLs this Apple ID has
/// connected to before, synced through `RecentJoinStore`. Kept beside the
/// live-session helpers because the two lists share a section and must not
/// show the same tray twice.
extension ICloudSessionList {
    /// The rows to render: recents that are not already visible as a live
    /// iCloud session, ranked reachable-first then newest-connected, capped.
    ///
    /// The exclusion keys on the shared one-way id — a recent recorded from a
    /// launcher-published session has the same identity as that session — so
    /// a tray that is live right now appears once, in the list that can say
    /// something about it.
    static func recentRows(
        from recents: [RecentJoin],
        excluding advertised: [SyncedTraySession],
        limit: Int = RecentJoinStore.maxRecents,
        isReachable: (String) -> Bool
    ) -> [RecentJoin] {
        let live = Set(advertised.map(\.id))
        return RecentJoinStore.rank(
            recents.filter { !live.contains($0.id) },
            limit: limit,
            isReachable: isReachable)
    }

    /// What a recent row calls itself. A hand-pasted URL has no label, so the
    /// host stands in — never the path, which carries the session secret.
    static func recentTitle(_ recent: RecentJoin) -> String {
        if !recent.label.isEmpty { return recent.label }
        if !recent.displayHost.isEmpty { return recent.displayHost }
        return "Sliccy session"
    }

    /// Provenance and age, plus the probe verdict when it is bad news. The
    /// device that recorded the row is named so a row synced from the iPad
    /// does not read as something this phone did.
    static func recentSubtitle(
        _ recent: RecentJoin,
        thisDeviceId: String,
        now: Date,
        unreachable: Bool
    ) -> String {
        let device =
            recent.deviceId == thisDeviceId
            ? "This device"
            : (recent.deviceName.isEmpty ? "Unknown device" : recent.deviceName)
        // The title already showed the host when there was no label; repeating
        // it here would say the same thing twice.
        let host = recent.label.isEmpty ? "" : recent.displayHost
        return [
            device, host.isEmpty ? nil : host, age(of: recent.lastConnectedAt, now: now),
            unreachable ? "not responding" : nil,
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }
}
