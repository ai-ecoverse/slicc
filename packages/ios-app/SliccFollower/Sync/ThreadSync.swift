import Foundation
import SliccTrayKit













struct ThreadSyncPlanner {
    
    
    
    static let peekProtocolVersion = 9

    
    
    
    static let maxUnits = 24

    
    
    
    static let requestTimeout: TimeInterval = 30

    
    private(set) var synced: Set<String> = []
    private var abandoned: Set<String> = []
    private(set) var inFlight: (jid: String, since: Date)?
    
    
    private var turnsSeen: [String: Double] = [:]

    
    
    
    mutating func reset() {
        synced.removeAll()
        abandoned.removeAll()
        inFlight = nil
        turnsSeen.removeAll()
    }

    
    mutating func snapshotArrived(for jid: String) {
        synced.insert(jid)
        if inFlight?.jid == jid { inFlight = nil }
    }

    
    
    
    
    
    
    
    
    
    mutating func rosterChanged(
        from previous: [ScoopSummary], to current: [ScoopSummary], selectedJid: String?
    ) {
        let wasWorking = Set(previous.filter { $0.state == "working" }.map(\.jid))
        let present = Set(current.map(\.jid))
        for unit in current {
            var finishedATurn = unit.state != "working" && wasWorking.contains(unit.jid)
            if let turns = unit.turns {
                if let seen = turnsSeen[unit.jid], seen != turns { finishedATurn = true }
                turnsSeen[unit.jid] = turns
            }
            if finishedATurn && unit.jid != selectedJid { synced.remove(unit.jid) }
        }
        synced.formIntersection(present)
        abandoned.formIntersection(present)
        turnsSeen = turnsSeen.filter { present.contains($0.key) }
    }

    
    
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
            
            unit.jid != selectedJid && !synced.contains(unit.jid) && !abandoned.contains(unit.jid)
        }
        guard let candidate else { return nil }
        inFlight = (candidate.jid, now)
        return candidate.jid
    }
}
