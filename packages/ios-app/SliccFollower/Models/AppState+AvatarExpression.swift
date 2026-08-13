import Foundation
import SliccTrayFollower

/// The follower's half of the agent-avatar expression channel.
///
/// `AppState` owns the two observed signals as stored properties and updates
/// them from its own `isStreaming` observer (an extension can neither add
/// storage nor write a `private(set)` setter across files); the derivation that
/// reads them lives here, where it is not competing for room in a file already
/// at its length limit.
extension AppState {
    /// What this follower observed for itself about the FOCUSED scoop.
    ///
    /// Precedence is **local > wire > unknown**: the tool bracket and the turn
    /// settle both land here before the leader's next `scoops.list` broadcast,
    /// so for the scoop on screen these win. Every other tab reads
    /// `ScoopSummary.state`.
    var localExpressionSignals: ScoopSummary.LocalExpressionSignals {
        .init(toolRunning: runningToolCalls > 0, awaitingUser: awaitingUserSince != nil)
    }
}
