import Foundation
import SliccTrayKit
import SliccTraySession
import UIKit
import os

/// Delivery-failure surfacing, separated from the main type body so the
/// connection coordinator stays under the lint size cap.
extension AppState {
    private static let deliveryLogger = Logger(
        subsystem: "com.slicc.follower", category: "AppState")

    /// Shown when a `rejected` ack arrives without the `error` the spec
    /// promises, so the bubble never says less than "it failed".
    static let genericDeliveryRejection = "The SLICC tab could not take this message."

    /// `user_message_echo` and `user_message_ack` — the leader's two answers
    /// about a user message.
    func handleDeliveryMessage(_ message: LeaderToFollowerMessage) {
        switch message {
        case .userMessageEcho(let text, let messageId, let scoopJid, let attachments):
            handleUserMessageEcho(
                text: text, messageId: messageId, scoopJid: scoopJid, attachments: attachments)
        case .userMessageAck(let messageId, _, let state, let error):
            handleUserMessageAck(messageId: messageId, state: state, error: error)
        default:
            break
        }
    }

    private func handleUserMessageEcho(
        text: String, messageId: String, scoopJid: String, attachments: [MessageAttachment]?
    ) {
        Self.deliveryLogger.debug("User message echo: id=\(messageId)")
        var buffer = messagesByScoop[scoopJid] ?? []
        guard !localSends.owns(messageId), !buffer.contains(where: { $0.id == messageId }) else {
            return
        }
        buffer.append(
            ChatMessage(
                id: messageId,
                role: .user,
                content: text,
                timestamp: Date().timeIntervalSince1970 * 1000,
                attachments: attachments
            ))
        messagesByScoop[scoopJid] = buffer
        if scoopJid == selectedScoopJid {
            messages = buffer
        }
    }

    /// `accepted` leaves the ledger alone: the ledger confirms a send only
    /// when a snapshot contains it, and a snapshot built before this delivery
    /// can still land after the ack — releasing the entry here would let that
    /// snapshot erase the prompt again.
    ///
    /// `rejected` flags the bubble the way a transport refusal does, and
    /// keeps the leader's reason next to it. Every buffer is searched rather
    /// than the ack's `scoopJid`: a send made before any unit was selected
    /// sits in whichever buffer the first snapshot adopted it into.
    private func handleUserMessageAck(
        messageId: String, state: UserMessageAckState, error: String?
    ) {
        guard state == .rejected else { return }
        Self.deliveryLogger.warning("Leader rejected message id=\(messageId)")
        deliveryRejections[messageId] =
            error.flatMap { $0.isEmpty ? nil : $0 } ?? Self.genericDeliveryRejection
        localSends.flagUndelivered(messageId)
        if let index = messages.firstIndex(where: { $0.id == messageId }) {
            messages[index].error = true
        }
        for (jid, buffer) in messagesByScoop {
            if let index = buffer.firstIndex(where: { $0.id == messageId }) {
                messagesByScoop[jid]?[index].error = true
            }
        }
    }

    /// The optimistic bubble must not lie: a send the transport refused
    /// (oversize past the 8 MiB tray ceiling, dead channel) is flagged on
    /// the message — the user bubble renders a "Not delivered" note and
    /// keeps its content — and surfaced in the transport banner.
    func markUndelivered(_ messageId: String) {
        localSends.flagUndelivered(messageId)
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
    /// `fixtureDefaults` decides whether this store is the real iCloud-backed
    /// one or an in-memory fixture. It is a parameter rather than a read of
    /// `UserDefaults.standard` so a unit test can hand over an ephemeral suite
    /// and get a store that touches neither iCloud nor any state another test
    /// in the (randomly ordered) bundle can see.
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

    /// Recently-connected join URLs, synced through the same iCloud KVS under
    /// their own key namespace. Unlike `sessionStore` the phone *is* a
    /// producer here: a URL pasted into this device is otherwise invisible to
    /// every other one. `deviceName` is passed explicitly because the shared
    /// package is Foundation-only and cannot reach `UIDevice`.
    /// `fixtureDefaults` carries the same isolation contract as
    /// `makeSessionStore(fixtureDefaults:)`.
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
