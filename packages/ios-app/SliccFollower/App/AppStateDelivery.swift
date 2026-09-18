import Foundation
import SliccTraySession
import UIKit



extension AppState {
    
    
    
    
    func markUndelivered(_ messageId: String) {
        if let index = messages.firstIndex(where: { $0.id == messageId }) {
            messages[index].error = true
        }
        if let jid = selectedScoopJid,
            let index = messagesByScoop[jid]?.firstIndex(where: { $0.id == messageId })
        {
            messagesByScoop[jid]?[index].error = true
        }
        lastError = "The message could not be delivered — it may be too large."
    }
}


extension AppState {
    
    
    
    
    
    static func makeSessionStore(
        fixtureDefaults: UserDefaults = .standard
    ) -> TraySessionSyncStore {
        #if DEBUG
            if let fixture = UITestHooks.sessionsFixtureBackend(defaults: fixtureDefaults) {
                return TraySessionSyncStore(
                    backend: fixture,
                    deviceId: "ios-under-test",
                    deviceName: "iPhone Under Test"
                )
            }
        #endif
        return TraySessionSyncStore()
    }

    
    
    
    
    
    
    
    static func makeRecentJoinStore(
        fixtureDefaults: UserDefaults = .standard
    ) -> RecentJoinStore {
        #if DEBUG
            if let fixture = UITestHooks.recentJoinsFixtureBackend(defaults: fixtureDefaults) {
                return RecentJoinStore(
                    backend: fixture,
                    deviceId: "ios-under-test",
                    deviceName: "iPhone Under Test"
                )
            }
        #endif
        return RecentJoinStore(deviceName: UIDevice.current.name)
    }
}
