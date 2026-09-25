import Foundation
import SliccTrayKit
import SliccTraySession
import UIKit
import os



extension AppState {
    private static let deliveryLogger = Logger(
        subsystem: "com.slicc.follower", category: "AppState")

    
    
    static let genericDeliveryRejection = "The SLICC tab could not take this message."

    
    
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
