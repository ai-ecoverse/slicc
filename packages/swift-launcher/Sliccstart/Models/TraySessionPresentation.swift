import Foundation
import SliccTraySession

enum TraySessionPresentation {
    static func sortedRemoteSessions(
        _ sessions: [SyncedTraySession],
        verdicts: [String: SessionReachability.Verdict]
    ) -> [SyncedTraySession] {
        let presumedReachable = attachableSessions(sessions, verdicts: verdicts)
        let unreachable = sessions.filter { verdicts[$0.id] == .unreachable }
        return presumedReachable + unreachable
    }

    /// Sessions the launcher may offer as attach targets. Only a confirmed
    /// `.unreachable` verdict excludes: unprobed sessions stay offered so a
    /// slow probe never hides a live session.
    static func attachableSessions(
        _ sessions: [SyncedTraySession],
        verdicts: [String: SessionReachability.Verdict]
    ) -> [SyncedTraySession] {
        sessions.filter { verdicts[$0.id] != .unreachable }
    }

    static func subtitle(
        isLocal: Bool,
        deviceName: String,
        lastSeenAt: Date,
        verdict: SessionReachability.Verdict?,
        now: Date = Date()
    ) -> String {
        let origin = isLocal ? "This device" : deviceName
        let status = verdict == .unreachable ? " · not responding" : ""
        return "\(origin) · \(age(of: lastSeenAt, now: now))\(status)"
    }

    static func remoteActionEnabled(
        available: Bool,
        verdict: SessionReachability.Verdict?
    ) -> Bool {
        available && verdict != .unreachable
    }

    static func age(of date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h ago" }
        return "\(Int(seconds / 86400))d ago"
    }
}
