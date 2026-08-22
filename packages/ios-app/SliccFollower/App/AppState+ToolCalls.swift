import Foundation
import SliccTrayKit

// MARK: - Tool-call rows
//
// Lives outside the `AppState` body, which sits against the SwiftLint
// `file_length` ceiling. `handleAgentEvent` dispatches the two tool events
// here; everything below owns how a `tool_result` finds its row.

extension AppState {
    /// Row id for a tool call. The provider's tool-call id is only unique
    /// within one assistant message, so it is scoped by message id — the same
    /// key the webapp uses (`WcChatController.#rowKey`), which keeps a provider
    /// that reuses an id in a later message from colliding with the older row.
    static func toolRowId(messageId: String, toolCallId: String) -> String {
        "\(messageId):\(toolCallId)"
    }

    /// Locate the row a `tool_result` belongs to. A message's tool calls run
    /// concurrently on the leader, so "last call with this name" attaches the
    /// output to the wrong row as soon as two same-named calls overlap. Pair by
    /// the provider id when it is present (accepting the bare id as well, for a
    /// history synced by an older build), and keep the name scan — restricted
    /// to calls still awaiting a result — for pre-#2306 leaders.
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

    /// Append the row a `tool_use_start` opens. The caller owns the in-flight
    /// counter — `runningToolCalls` has a file-private setter.
    func applyToolUseStart(
        messageId: String, toolName: String, toolInput: AnyCodable?, toolCallId: String?,
        buffer: inout [ChatMessage], scoopJid: String, isVisible: Bool
    ) {
        guard let idx = buffer.firstIndex(where: { $0.id == messageId }) else { return }
        // Adopt the provider's tool-call id so the result pairs by identity; a
        // random id only for pre-#2306 leaders, which leave the name scan its
        // unavoidable ambiguity.
        let rowId = toolCallId.map { Self.toolRowId(messageId: messageId, toolCallId: $0) }
        let tc = ToolCall(id: rowId ?? UUID().uuidString, name: toolName, input: toolInput)
        buffer[idx].toolCalls = (buffer[idx].toolCalls ?? []) + [tc]
        publish(buffer: buffer, scoopJid: scoopJid, isVisible: isVisible)
    }

    /// Settle the row a `tool_result` belongs to. As with `applyToolUseStart`,
    /// the caller owns the in-flight counter and the failure glower.
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
        // A settled call has no progress left to report. The leader sends a
        // `phase: end` tick too, but only for units it opened — clearing here
        // covers a call that died mid-run.
        if let rowId = buffer[idx].toolCalls?[tcIdx].id { toolProgress[rowId] = nil }
        publish(buffer: buffer, scoopJid: scoopJid, isVisible: isVisible)
    }

    /// Live progress tick for a running call. Ticks arrive up to ~4/s per unit,
    /// so this only touches the `toolProgress` map — the transcript itself is
    /// unchanged, and the row treatment redraws off that one published value.
    /// Progress for a background scoop is kept: switching to it mid-run should
    /// find the bar where the leader left it.
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

    /// Drop the units belonging to one message's rows. Called when that turn
    /// ends (or dies), which is per-message and therefore per-scoop: clearing
    /// on the `isStreaming` edge instead would wipe a background scoop's bars
    /// the moment you switched to another one, since `selectScoop` moves that
    /// flag too.
    func clearToolProgress(for message: ChatMessage) {
        guard !toolProgress.isEmpty else { return }
        for call in message.toolCalls ?? [] { toolProgress[call.id] = nil }
    }

    /// A snapshot is the leader re-describing a scoop's transcript. Rows it
    /// dropped can never be rendered again, so their units would sit in the map
    /// forever; rows it kept stay live (the leader mints the same
    /// `<messageId>:<toolCallId>` row ids the follower does), so a run that
    /// spans a reconnect keeps its bar.
    func pruneToolProgress(replacing old: [ChatMessage], with new: [ChatMessage]) {
        guard !toolProgress.isEmpty else { return }
        let surviving = Set(new.flatMap { $0.toolCalls ?? [] }.map(\.id))
        for call in old.flatMap({ $0.toolCalls ?? [] }) where !surviving.contains(call.id) {
            toolProgress[call.id] = nil
        }
    }

    /// Commit a mutated scoop buffer, mirroring it onto the visible transcript.
    private func publish(buffer: [ChatMessage], scoopJid: String, isVisible: Bool) {
        messagesByScoop[scoopJid] = buffer
        guard isVisible else { return }
        cancelPendingMessagesFlush()
        messages = buffer
    }
}
