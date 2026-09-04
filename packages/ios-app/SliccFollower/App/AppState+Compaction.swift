import Foundation
import SliccTrayKit

// MARK: - Compaction marker rows
//
// Lives outside the `AppState` body, which sits against the SwiftLint
// `file_length` ceiling. `handleAgentEvent` dispatches `compaction_notice`
// here.
//
// One row per ROUND: the leader keeps `messageId` stable for the whole round,
// so the opening state inserts and the terminal state updates in place. What
// this must never do is touch turn state — a compaction is not an assistant
// turn, and the leader modelling it as one is exactly what stranded the web
// composer in its busy state for a whole session (#2843).

extension AppState {
    /// Insert, update, or retract a compaction row in `buffer`.
    func applyCompactionNotice(
        messageId: String,
        marker: ChatCompactionMarker,
        buffer: inout [ChatMessage],
        scoopJid: String,
        isVisible: Bool
    ) {
        let existing = buffer.firstIndex { $0.id == messageId }

        // The round kept nothing. Remove the row rather than relabel it: a
        // transcript that keeps announcing a compaction which did not happen
        // is worse than one that says nothing about it.
        if marker.state == .discarded {
            guard let idx = existing else { return }
            buffer.remove(at: idx)
            publishCompaction(buffer: buffer, scoopJid: scoopJid, isVisible: isVisible)
            return
        }

        if let idx = existing {
            buffer[idx].compaction = marker
        } else {
            buffer.append(
                ChatMessage(
                    id: messageId,
                    role: .assistant,
                    // The body is never rendered — `CompactionMarkerRow`
                    // derives every word from `trigger` + `state`.
                    content: "",
                    timestamp: Date().timeIntervalSince1970 * 1000,
                    compaction: marker
                ))
        }
        publishCompaction(buffer: buffer, scoopJid: scoopJid, isVisible: isVisible)
    }

    /// Commit a mutated scoop buffer, mirroring it onto the visible transcript.
    ///
    /// Flushes immediately instead of coalescing: a marker arrives at most a
    /// few times per round, so there is no redraw storm to debounce, and a
    /// retraction that sat in a pending flush would leave a stale row on screen.
    private func publishCompaction(buffer: [ChatMessage], scoopJid: String, isVisible: Bool) {
        messagesByScoop[scoopJid] = buffer
        guard isVisible else { return }
        cancelPendingMessagesFlush()
        messages = buffer
    }
}
