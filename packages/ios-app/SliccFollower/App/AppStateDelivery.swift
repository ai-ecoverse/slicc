import Foundation

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
