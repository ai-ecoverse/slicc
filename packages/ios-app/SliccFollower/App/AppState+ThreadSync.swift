import Foundation
import SliccTrayKit







extension AppState {
    
    
    
    func threadRosterChanged(from previous: [ScoopSummary]) {
        threadSync.rosterChanged(from: previous, to: scoops, selectedJid: selectedScoopJid)
        prefetchNextThread()
    }

    
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
        
        
        
        _ = sendToLeader(.requestSnapshot(scoopJid: jid, peek: true))
    }
}
