import Foundation
import SliccTrayKit

/// The user messages THIS device sent that no snapshot has confirmed yet.
///
/// A snapshot replaces a unit's buffer wholesale, and it describes the moment
/// the leader BUILT it, not the moment it arrives. A large thread's snapshot is
/// read asynchronously and delivered in chunks, so there is a real window —
/// switch to a busy cone and send straight away, or send across a reconnect —
/// in which a snapshot built before the prompt reached the leader lands after
/// the prompt was appended locally, and erases it. The message was delivered;
/// it just stopped being on the sender's own screen.
///
/// The ledger holds each send until a snapshot contains it, and
/// `reconcile` puts back the ones a snapshot is missing. An entry also expires
/// on its own: a prompt the leader never recorded must not be re-asserted
/// against every later snapshot for the rest of the session.
struct LocalSendLedger {
    /// How long an unconfirmed send outranks a snapshot that lacks it. Long
    /// enough for a chunked snapshot of a large thread on a poor link; short
    /// enough that a genuinely lost prompt stops haunting the transcript.
    static let confirmationWindow: TimeInterval = 60

    private struct Entry {
        /// `nil` for a send made before any unit was selected — see `record`.
        var scoopJid: String?
        var message: ChatMessage
        let sentAt: Date
    }

    private var entries: [String: Entry] = [:]

    /// Whether `messageId` is a send this device still holds unconfirmed.
    func owns(_ messageId: String) -> Bool { entries[messageId] != nil }

    /// `scoopJid` is `nil` in the window after the channel opens and before
    /// the first snapshot or roster names a unit: the composer already works,
    /// and the leader delivers such a prompt to the unit it is displaying —
    /// which is the unit its first snapshot describes. The entry is held
    /// unscoped and adopted by the first snapshot to arrive.
    mutating func record(_ message: ChatMessage, scoopJid: String?, now: Date = Date()) {
        entries[message.id] = Entry(scoopJid: scoopJid, message: message, sentAt: now)
    }

    /// The transport refused this send. It stays in the ledger — the bubble
    /// keeps its content — but as the flagged copy, so a snapshot that puts it
    /// back cannot quietly turn "Not delivered" into a delivered-looking prompt.
    mutating func flagUndelivered(_ messageId: String) {
        entries[messageId]?.message.error = true
    }

    mutating func removeAll() { entries.removeAll() }

    /// `snapshot` for `scoopJid`, with this device's unconfirmed sends put
    /// back. Sends the snapshot already contains are confirmed and dropped
    /// from the ledger; expired ones are dropped without being re-applied.
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
