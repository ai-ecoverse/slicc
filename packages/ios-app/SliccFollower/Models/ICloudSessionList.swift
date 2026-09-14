import Foundation
import SliccTraySession




enum ICloudSessionList {
    
    
    
    struct DeviceGroup: Equatable, Identifiable {
        let deviceId: String
        let deviceName: String
        let sessions: [SyncedTraySession]
        var id: String { deviceId }
    }

    
    
    
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

    
    
    
    
    
    enum EmptyReason: Equatable {
        case iCloudUnavailable
        case noSessions
    }

    static func emptyReason(hasICloudIdentity: Bool) -> EmptyReason {
        hasICloudIdentity ? .noSessions : .iCloudUnavailable
    }

    
    
    
    static func age(of date: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h ago" }
        return "\(Int(seconds / 86_400))d ago"
    }
}





extension ICloudSessionList {
    
    
    
    
    
    
    
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

    
    
    static func recentTitle(_ recent: RecentJoin) -> String {
        if !recent.label.isEmpty { return recent.label }
        if !recent.displayHost.isEmpty { return recent.displayHost }
        return "Sliccy session"
    }

    
    
    
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
        
        
        let host = recent.label.isEmpty ? "" : recent.displayHost
        return [
            device, host.isEmpty ? nil : host, age(of: recent.lastConnectedAt, now: now),
            unreachable ? "not responding" : nil,
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }
}
