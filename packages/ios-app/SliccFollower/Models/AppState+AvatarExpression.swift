import Foundation
import SliccTrayFollower

extension AppState {

    var localExpressionSignals: ScoopSummary.LocalExpressionSignals {
        .init(toolRunning: runningToolCalls > 0, awaitingUser: awaitingUserSince != nil)
    }
}
