import Foundation

/// Stamps each work unit with when it was last seen to change.
///
/// The widget orders units by recency, and `ScoopSummary` carries no
/// timestamp — the leader never sends one. So recency cannot be read, only
/// observed: the capture side keeps the last state it saw per unit and stamps
/// the moment that state moves. A unit that just started thinking, just
/// finished, just broke or just filled another percent is, by that definition,
/// the most recent thing in the session — which is also what someone glancing
/// at a home screen means by it.
///
/// Cheap on purpose: two dictionaries keyed by jid, no history. It lives here
/// rather than in either app because both capture sides need exactly this and
/// a widget whose order differed by platform would be a bug nobody could see.
public struct UnitRecencyLedger {
    private var stamps: [String: Date] = [:]
    private var fingerprints: [String: String] = [:]

    public init() {}

    /// Return `units` with `lastActivityAt` filled in, updating the ledger.
    ///
    /// A unit seen for the first time is stamped `now`: it is new, and new is
    /// the most recent thing that can happen to it. Units that have left the
    /// session are forgotten, so a scoop that comes back later does not
    /// inherit a stale position in the order.
    public mutating func stamp(_ units: [WidgetUnit], now: Date) -> [WidgetUnit] {
        var nextStamps: [String: Date] = [:]
        var nextFingerprints: [String: String] = [:]
        let stamped = units.map { unit -> WidgetUnit in
            let fingerprint = unit.activityFingerprint
            let changed = fingerprints[unit.id] != fingerprint
            let at = changed ? now : (stamps[unit.id] ?? now)
            nextStamps[unit.id] = at
            nextFingerprints[unit.id] = fingerprint
            return unit.stamped(lastActivityAt: at)
        }
        stamps = nextStamps
        fingerprints = nextFingerprints
        return stamped
    }
}

extension WidgetUnit {
    /// A copy carrying a recency stamp. Everything else is unchanged.
    public func stamped(lastActivityAt: Date?) -> WidgetUnit {
        WidgetUnit(
            id: id, name: name, role: role, parentId: parentId, lifecycle: lifecycle,
            activity: activity, fill: fill, model: model, detail: detail, isActive: isActive,
            lastActivityAt: lastActivityAt)
    }
}
