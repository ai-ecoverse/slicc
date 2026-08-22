import Foundation
import SliccTraySession
import UIKit

/// Delivery-failure surfacing, separated from the main type body so the
/// connection coordinator stays under the lint size cap.
extension AppState {
    /// The optimistic bubble must not lie: a send the transport refused
    /// (oversize past the 8 MiB tray ceiling, dead channel) is flagged on
    /// the message — the user bubble renders a "Not delivered" note and
    /// keeps its content — and surfaced in the transport banner.
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

/// Session-store construction, out of the main type body (lint size cap).
extension AppState {
    static func makeSessionStore() -> TraySessionSyncStore {
        #if DEBUG
            if let fixture = UITestHooks.sessionsFixtureBackend() {
                return TraySessionSyncStore(
                    backend: fixture,
                    deviceId: "ios-under-test",
                    deviceName: "iPhone Under Test"
                )
            }
        #endif
        return TraySessionSyncStore()
    }

    /// Recently-connected join URLs, synced through the same iCloud KVS under
    /// their own key namespace. Unlike `sessionStore` the phone *is* a
    /// producer here: a URL pasted into this device is otherwise invisible to
    /// every other one. `deviceName` is passed explicitly because the shared
    /// package is Foundation-only and cannot reach `UIDevice`.
    static func makeRecentJoinStore() -> RecentJoinStore {
        #if DEBUG
            if let fixture = UITestHooks.recentJoinsFixtureBackend() {
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
