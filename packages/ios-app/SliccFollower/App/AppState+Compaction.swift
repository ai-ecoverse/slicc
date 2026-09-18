import Foundation
import SliccTrayKit













extension AppState {
    
    func applyCompactionNotice(
        messageId: String,
        marker: ChatCompactionMarker,
        buffer: inout [ChatMessage],
        scoopJid: String,
        isVisible: Bool
    ) {
        let existing = buffer.firstIndex { $0.id == messageId }

        
        
        
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
                    
                    
                    content: "",
                    timestamp: Date().timeIntervalSince1970 * 1000,
                    compaction: marker
                ))
        }
        publishCompaction(buffer: buffer, scoopJid: scoopJid, isVisible: isVisible)
    }

    
    
    
    
    
    private func publishCompaction(buffer: [ChatMessage], scoopJid: String, isVisible: Bool) {
        messagesByScoop[scoopJid] = buffer
        guard isVisible else { return }
        cancelPendingMessagesFlush()
        messages = buffer
    }
}
