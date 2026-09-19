import Foundation
import SliccTrayKit















struct LocalSendLedger {
    
    
    
    static let confirmationWindow: TimeInterval = 60

    private struct Entry {
        
        var scoopJid: String?
        var message: ChatMessage
        let sentAt: Date
    }

    private var entries: [String: Entry] = [:]

    
    func owns(_ messageId: String) -> Bool { entries[messageId] != nil }

    
    
    
    
    
    mutating func record(_ message: ChatMessage, scoopJid: String?, now: Date = Date()) {
        entries[message.id] = Entry(scoopJid: scoopJid, message: message, sentAt: now)
    }

    
    
    
    mutating func flagUndelivered(_ messageId: String) {
        entries[messageId]?.message.error = true
    }

    mutating func removeAll() { entries.removeAll() }

    
    
    
    mutating func reconcile(
        snapshot: [ChatMessage], scoopJid: String, now: Date = Date()
    ) -> [ChatMessage] {
        guard !entries.isEmpty else { return snapshot }
        let confirmed = Set(snapshot.map(\.id))
        var missing: [Entry] = []
        for (id, entry) in entries {
            if now.timeIntervalSince(entry.sentAt) > Self.confirmationWindow {
                entries[id] = nil
            } else if entry.scoopJid == nil || entry.scoopJid == scoopJid {
                if confirmed.contains(id) {
                    entries[id] = nil
                } else {
                    entries[id]?.scoopJid = scoopJid
                    missing.append(entry)
                }
            }
        }
        guard !missing.isEmpty else { return snapshot }
        return snapshot + missing.sorted { $0.sentAt < $1.sentAt }.map(\.message)
    }
}
