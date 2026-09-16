import Foundation
import SliccTrayKit

extension AppState {

    static func toolRowId(messageId: String, toolCallId: String) -> String {
        "\(messageId):\(toolCallId)"
    }

    static func toolCallIndex(
        in calls: [ToolCall]?, messageId: String, toolName: String, toolCallId: String?
    ) -> Int? {
        guard let calls else { return nil }
        if let toolCallId {
            let scoped = toolRowId(messageId: messageId, toolCallId: toolCallId)
            return calls.firstIndex { $0.id == scoped } ?? calls.firstIndex { $0.id == toolCallId }
        }
        return calls.lastIndex { $0.name == toolName && $0.result == nil }
    }

    func applyToolUseStart(
        messageId: String, toolName: String, toolInput: AnyCodable?, toolCallId: String?,
        buffer: inout [ChatMessage], scoopJid: String, isVisible: Bool
    ) {
        guard let idx = buffer.firstIndex(where: { $0.id == messageId }) else { return }

        fileMentionResolver.absorb(toolInput: toolInput)
        let rowId = toolCallId.map { Self.toolRowId(messageId: messageId, toolCallId: $0) }
        let tc = ToolCall(id: rowId ?? UUID().uuidString, name: toolName, input: toolInput)
        buffer[idx].toolCalls = (buffer[idx].toolCalls ?? []) + [tc]
        publish(buffer: buffer, scoopJid: scoopJid, isVisible: isVisible)
    }

    func applyToolResult(
        messageId: String, toolName: String, result: String, isError: Bool?, toolCallId: String?,
        buffer: inout [ChatMessage], scoopJid: String, isVisible: Bool
    ) {
        guard let idx = buffer.firstIndex(where: { $0.id == messageId }),
            let tcIdx = Self.toolCallIndex(
                in: buffer[idx].toolCalls, messageId: messageId, toolName: toolName,
                toolCallId: toolCallId)
        else { return }
        buffer[idx].toolCalls?[tcIdx].result = result
        buffer[idx].toolCalls?[tcIdx].isError = isError

        if let rowId = buffer[idx].toolCalls?[tcIdx].id { toolProgress[rowId] = nil }
        publish(buffer: buffer, scoopJid: scoopJid, isVisible: isVisible)
    }

    func applyToolProgress(
        messageId: String, toolName: String, progress: ToolProgressEvent, toolCallId: String?,
        buffer: [ChatMessage]
    ) {
        guard let idx = buffer.firstIndex(where: { $0.id == messageId }),
            let tcIdx = Self.toolCallIndex(
                in: buffer[idx].toolCalls, messageId: messageId, toolName: toolName,
                toolCallId: toolCallId),
            let rowId = buffer[idx].toolCalls?[tcIdx].id
        else { return }
        if progress.phase == .end {
            toolProgress[rowId] = nil
        } else {
            toolProgress[rowId] = progress
        }
    }

    func clearToolProgress(for message: ChatMessage) {
        guard !toolProgress.isEmpty else { return }
        for call in message.toolCalls ?? [] { toolProgress[call.id] = nil }
    }

    func pruneToolProgress(replacing old: [ChatMessage], with new: [ChatMessage]) {
        guard !toolProgress.isEmpty else { return }
        let surviving = Set(new.flatMap { $0.toolCalls ?? [] }.map(\.id))
        for call in old.flatMap({ $0.toolCalls ?? [] }) where !surviving.contains(call.id) {
            toolProgress[call.id] = nil
        }
    }

    private func publish(buffer: [ChatMessage], scoopJid: String, isVisible: Bool) {
        messagesByScoop[scoopJid] = buffer
        guard isVisible else { return }
        cancelPendingMessagesFlush()
        messages = buffer
    }
}
