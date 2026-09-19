import Foundation
import SliccTrayKit

/// Decides which unit's transcript to fetch next, in the background, so that
/// switching to it paints a finished transcript instead of a blank one.
///
/// The follower already keeps a per-unit buffer (`AppState.messagesByScoop`)
/// and shows it the instant a unit is selected — but a unit nobody has visited
/// this connection has no buffer, so the first switch to a busy cone waited on
/// a multi-megabyte chunked snapshot. This planner fills those buffers ahead of
/// the switch, one unit at a time, with `request_snapshot.peek`.
///
/// It is the iOS counterpart of the web's `RemoteWorkUnitClient.lastSnapshots`,
/// kept as a value type with no I/O so every rule below is unit-tested without
/// a leader: `AppState+ThreadSync` owns the sending.
struct ThreadSyncPlanner {
    /// The first leader that honours `peek`. Below it a snapshot request for
    /// another unit RE-POINTS this follower's selection on the leader — which
    /// routes its prompts and its `abort` — so nothing is prefetched at all.
    static let peekProtocolVersion = 9

    /// A roster can hold dozens of short-lived scoops; transcripts are the
    /// heaviest thing the follower keeps. Roots come first, so the cap trims
    /// scoops, which are read-only and visited far less.
    static let maxUnits = 24

    /// How long one request may go unanswered before the next unit gets its
    /// turn. A large thread is chunked over a phone link, so this is generous;
    /// an unanswered unit is not retried until the next connection.
    static let requestTimeout: TimeInterval = 30

    /// Units whose buffer holds a snapshot from THIS connection.
    private(set) var synced: Set<String> = []
    private var abandoned: Set<String> = []
    private(set) var inFlight: (jid: String, since: Date)?

    /// A new connection: the leader may have cleared, frozen or dropped any
    /// unit meanwhile. The buffers stay (they still paint instantly) but every
    /// one of them is refetched.
    mutating func reset() {
        synced.removeAll()
        abandoned.removeAll()
        inFlight = nil
    }

    /// A snapshot for `jid` landed, whoever asked for it.
    mutating func snapshotArrived(for jid: String) {
        synced.insert(jid)
        if inFlight?.jid == jid { inFlight = nil }
    }

    /// Units that finished a turn off screen since `previous`. The leader
    /// streams only the unit it is displaying and the units a follower has
    /// selected, so every other buffer goes stale the moment its unit works —
    /// and the roster's `working → not working` edge is the one signal that
    /// says so.
    mutating func rosterChanged(
        from previous: [ScoopSummary], to current: [ScoopSummary], selectedJid: String?
    ) {
        let wasWorking = Set(previous.filter { $0.state == "working" }.map(\.jid))
        let present = Set(current.map(\.jid))
        for unit in current
        where unit.jid != selectedJid && unit.state != "working" && wasWorking.contains(unit.jid) {
            synced.remove(unit.jid)
        }
        synced.formIntersection(present)
        abandoned.formIntersection(present)
    }

    /// The unit to request now, or `nil` when there is nothing to do or a
    /// request is still outstanding. Marks the returned unit in flight.
    mutating func next(
        roster: [ScoopSummary], selectedJid: String?, leaderVersion: Int?, now: Date = Date()
    ) -> String? {
        guard (leaderVersion ?? 0) >= Self.peekProtocolVersion, let selectedJid else { return nil }
        if let pending = inFlight {
            guard now.timeIntervalSince(pending.since) > Self.requestTimeout else { return nil }
            abandoned.insert(pending.jid)
            inFlight = nil
        }
        let ordered = roster.filter(\.isRootUnit) + roster.filter { !$0.isRootUnit }
        let candidate = ordered.prefix(Self.maxUnits).first { unit in
            // The selected unit is synced by its own `scoops.select`.
            unit.jid != selectedJid && !synced.contains(unit.jid) && !abandoned.contains(unit.jid)
        }
        guard let candidate else { return nil }
        inFlight = (candidate.jid, now)
        return candidate.jid
    }
}
