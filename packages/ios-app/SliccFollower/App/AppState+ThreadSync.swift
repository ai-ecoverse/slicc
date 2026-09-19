import Foundation
import SliccTrayKit

// MARK: - Background thread sync

// The three seams `AppState` calls into. They live here because the `AppState`
// body sits against the SwiftLint `file_length` ceiling, and because the rules
// themselves are `ThreadSyncPlanner`'s — this file only sends.

extension AppState {
    /// A roster landed: note which units finished a turn off screen, then keep
    /// the prefetch moving. The leader re-sends the roster every few seconds,
    /// which is also what retires a request that never got an answer.
    func threadRosterChanged(from previous: [ScoopSummary]) {
        threadSync.rosterChanged(from: previous, to: scoops, selectedJid: selectedScoopJid)
        prefetchNextThread()
    }

    /// A snapshot landed — a prefetched one, or the selected unit's own.
    func threadSnapshotArrived(for scoopJid: String) {
        threadSync.snapshotArrived(for: scoopJid)
        prefetchNextThread()
    }

    private func prefetchNextThread() {
        guard
            let jid = threadSync.next(
                roster: scoops, selectedJid: selectedScoopJid,
                leaderVersion: leaderProtocolVersion)
        else { return }
        // A refused send is not retried here: `next` holds the unit in flight
        // until its timeout, and a channel that refuses this is about to be
        // replaced by one that starts from `reset()`.
        _ = sendToLeader(.requestSnapshot(scoopJid: jid, peek: true))
    }
}
