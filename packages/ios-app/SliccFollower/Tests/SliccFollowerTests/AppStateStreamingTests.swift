import Foundation
import SliccTrayKit
import XCTest

@testable import SliccFollower

final class AppStateStreamingTests: XCTestCase {
    func testDecodeFailureSummaryNeverIncludesRawURLPayload() {
        let secretURL = "fixtureapp://calendar/create?token=never-log-this"
        let malformed = Data(
            "{\"type\":\"exec.request\",\"command\":\"open \(secretURL)\"}".utf8)

        let summary = SafeLeaderMessageLog.decodeFailureSummary(malformed)

        XCTAssertTrue(summary.contains("type=exec.request"))
        XCTAssertTrue(summary.contains("\(malformed.count) bytes"))
        XCTAssertFalse(summary.contains(secretURL))
        XCTAssertFalse(summary.contains("never-log-this"))
    }

    func testDecodeFailureSummaryRejectsSensitiveDiscriminator() {
        let secretURL = "fixtureapp://calendar/create?token=never-log-this"
        let malformed = Data("{\"type\":\"\(secretURL)\"}".utf8)

        XCTAssertEqual(
            SafeLeaderMessageLog.decodeFailureSummary(malformed),
            "Failed to decode leader message (\(malformed.count) bytes, type=unknown)")
    }

    func testURLLogSummaryNeverIncludesQueryValues() {
        let secretURL = "https://example.com/action?token=never-log-this"

        let summary = SafeLeaderMessageLog.urlEventSummary(
            "Leader requested new tab", url: secretURL)

        XCTAssertTrue(summary.contains("\(secretURL.utf8.count) URL bytes"))
        XCTAssertFalse(summary.contains(secretURL))
        XCTAssertFalse(summary.contains("never-log-this"))
    }

    @MainActor
    private func send(_ event: AgentEvent, scoopJid: String, to state: AppState) throws {
        let message = LeaderToFollowerMessage.agentEvent(event: event, scoopJid: scoopJid)
        state.handleDataChannelMessage(try JSONEncoder().encode(message))
    }

    @MainActor
    private func sendStatus(_ status: String, scoopJid: String, to state: AppState) throws {
        let message = LeaderToFollowerMessage.status(scoopStatus: status, scoopJid: scoopJid)
        state.handleDataChannelMessage(try JSONEncoder().encode(message))
    }

    @MainActor
    func testContentDoneThenToolUseKeepsStopSteerAvailable() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"

        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(
            .contentDone(messageId: "reply", model: nil, usage: nil),
            scoopJid: "cone", to: state)
        try send(
            .toolUseStart(messageId: "reply", toolName: "bash", toolInput: nil),
            scoopJid: "cone", to: state)

        XCTAssertTrue(state.isStreaming)
        XCTAssertEqual(state.streamingMessageId, "reply")
        XCTAssertEqual(try XCTUnwrap(state.messages.last).isStreaming, false)
        XCTAssertEqual(state.messages.last?.toolCalls?.last?.name, "bash")
    }

    /// A message's tool calls run concurrently on the leader, so three `bash`
    /// calls can be in flight at once. Pairing by name attached each result to
    /// the last same-named row and visibly crossed the outputs; the provider id
    /// pins each result to its own row.
    @MainActor
    func testParallelSameNamedToolResultsPairByCallId() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        for id in ["call-1", "call-2", "call-3"] {
            try send(
                .toolUseStart(
                    messageId: "reply", toolName: "bash", toolInput: nil, toolCallId: id),
                scoopJid: "cone", to: state)
        }

        // Results land out of order, as they do when the shortest command wins.
        for (id, output) in [("call-3", "CCC"), ("call-1", "AAA"), ("call-2", "BBB")] {
            try send(
                .toolResult(
                    messageId: "reply", toolName: "bash", result: output, isError: false,
                    toolCallId: id),
                scoopJid: "cone", to: state)
        }

        let calls = try XCTUnwrap(state.messages.last?.toolCalls)
        XCTAssertEqual(calls.map(\.result), ["AAA", "BBB", "CCC"])
        XCTAssertEqual(calls.map(\.id), ["reply:call-1", "reply:call-2", "reply:call-3"])
    }

    /// A progress tick lands on the row its call id names, not on the newest
    /// same-named row — the same pairing `tool_result` uses.
    @MainActor
    func testToolProgressPairsByCallIdAndClearsOnResult() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        for id in ["call-1", "call-2"] {
            try send(
                .toolUseStart(
                    messageId: "reply", toolName: "bash", toolInput: nil, toolCallId: id),
                scoopJid: "cone", to: state)
        }

        try send(
            .toolProgress(
                messageId: "reply", toolName: "bash",
                progress: ToolProgressEvent(
                    id: "u1", label: "sleep 30", fraction: 0.4, phase: .update),
                toolCallId: "call-1"),
            scoopJid: "cone", to: state)

        XCTAssertEqual(state.toolProgress["reply:call-1"]?.fraction, 0.4)
        XCTAssertNil(state.toolProgress["reply:call-2"])

        // The result settles the row, so its unit goes with it even if the
        // leader never sends the closing `end` tick.
        try send(
            .toolResult(
                messageId: "reply", toolName: "bash", result: "ok", isError: false,
                toolCallId: "call-1"),
            scoopJid: "cone", to: state)
        XCTAssertTrue(state.toolProgress.isEmpty)
    }

    /// `phase: end` clears the unit on its own, and the turn that owns the row
    /// clears whatever is left — a bar must never outlive the run that painted
    /// it.
    @MainActor
    func testToolProgressEndPhaseAndTurnEndClearUnits() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(
            .toolUseStart(
                messageId: "reply", toolName: "bash", toolInput: nil, toolCallId: "call-1"),
            scoopJid: "cone", to: state)
        try send(
            .toolProgress(
                messageId: "reply", toolName: "bash",
                progress: ToolProgressEvent(id: "u1", label: "sleep 30", phase: .update),
                toolCallId: "call-1"),
            scoopJid: "cone", to: state)
        XCTAssertNotNil(state.toolProgress["reply:call-1"])

        try send(
            .toolProgress(
                messageId: "reply", toolName: "bash",
                progress: ToolProgressEvent(id: "u1", label: "sleep 30", phase: .end),
                toolCallId: "call-1"),
            scoopJid: "cone", to: state)
        XCTAssertTrue(state.toolProgress.isEmpty)

        // Re-open a unit and let the turn settle instead.
        try send(
            .toolProgress(
                messageId: "reply", toolName: "bash",
                progress: ToolProgressEvent(id: "u2", label: "sleep 30", phase: .start),
                toolCallId: "call-1"),
            scoopJid: "cone", to: state)
        XCTAssertFalse(state.toolProgress.isEmpty)
        try send(.turnEnd(messageId: "reply"), scoopJid: "cone", to: state)
        XCTAssertTrue(state.toolProgress.isEmpty)
    }

    /// `selectScoop` moves `isStreaming`, so clearing progress on that edge
    /// wiped the bars of every OTHER scoop that was still running. A background
    /// run keeps its units until its own turn ends.
    @MainActor
    func testSwitchingScoopsKeepsBackgroundProgress() throws {
        let state = AppState()
        state.scoops = [
            ScoopSummary(
                jid: "cone", name: "cone", folder: "/workspace", isCone: true,
                assistantLabel: "sliccy", trigger: nil, state: nil, fill: nil),
            ScoopSummary(
                jid: "other", name: "other", folder: "/scoops/other", isCone: false,
                assistantLabel: "other", trigger: nil, state: nil, fill: nil),
        ]
        state.selectedScoopJid = "cone"

        try send(.messageStart(messageId: "bg"), scoopJid: "other", to: state)
        try send(
            .toolUseStart(
                messageId: "bg", toolName: "bash", toolInput: nil, toolCallId: "call-1"),
            scoopJid: "other", to: state)
        try send(
            .toolProgress(
                messageId: "bg", toolName: "bash",
                progress: ToolProgressEvent(id: "u1", label: "sleep 300", phase: .update),
                toolCallId: "call-1"),
            scoopJid: "other", to: state)
        XCTAssertNotNil(state.toolProgress["bg:call-1"])

        state.selectScoop(jid: "other")
        state.selectScoop(jid: "cone")

        XCTAssertNotNil(
            state.toolProgress["bg:call-1"],
            "a background scoop's bar must survive a scoop switch")

        // Its own turn ending is what clears it.
        try send(.turnEnd(messageId: "bg"), scoopJid: "other", to: state)
        XCTAssertNil(state.toolProgress["bg:call-1"])
    }

    /// A snapshot that drops a row drops its unit with it; a snapshot that
    /// keeps the row keeps the bar, so a run spanning a reconnect is unbroken.
    @MainActor
    func testSnapshotPrunesUnitsForRowsItRemoved() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(
            .toolUseStart(
                messageId: "reply", toolName: "bash", toolInput: nil, toolCallId: "call-1"),
            scoopJid: "cone", to: state)
        try send(
            .toolProgress(
                messageId: "reply", toolName: "bash",
                progress: ToolProgressEvent(id: "u1", label: "sleep 30", phase: .update),
                toolCallId: "call-1"),
            scoopJid: "cone", to: state)

        let kept = ChatMessage(
            id: "reply", role: .assistant, content: "", timestamp: 0,
            toolCalls: [ToolCall(id: "reply:call-1", name: "bash", input: nil)])
        state.pruneToolProgress(replacing: state.messages, with: [kept])
        XCTAssertNotNil(state.toolProgress["reply:call-1"])

        state.pruneToolProgress(replacing: [kept], with: [])
        XCTAssertNil(state.toolProgress["reply:call-1"])
    }

    /// A tick for a call the transcript has never seen is dropped rather than
    /// parked under a key no row will ever read.
    @MainActor
    func testToolProgressForUnknownCallIsIgnored() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)

        try send(
            .toolProgress(
                messageId: "reply", toolName: "bash",
                progress: ToolProgressEvent(id: "u1", label: "sleep 30", phase: .update),
                toolCallId: "call-ghost"),
            scoopJid: "cone", to: state)

        XCTAssertTrue(state.toolProgress.isEmpty)
    }

    /// Pre-#2306 leaders send no id. The name scan stays, but it may only claim
    /// a row that is still awaiting its result — otherwise a second call's
    /// output overwrites the first one's.
    @MainActor
    func testResultsWithoutCallIdFillEachRowOnce() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(
            .toolUseStart(messageId: "reply", toolName: "bash", toolInput: nil),
            scoopJid: "cone", to: state)
        try send(
            .toolUseStart(messageId: "reply", toolName: "bash", toolInput: nil),
            scoopJid: "cone", to: state)
        try send(
            .toolResult(messageId: "reply", toolName: "bash", result: "first", isError: false),
            scoopJid: "cone", to: state)
        try send(
            .toolResult(messageId: "reply", toolName: "bash", result: "second", isError: false),
            scoopJid: "cone", to: state)

        let calls = try XCTUnwrap(state.messages.last?.toolCalls)
        XCTAssertEqual(Set(calls.compactMap(\.result)), ["first", "second"])
    }

    /// A history synced from a build that stored the bare provider id still
    /// pairs — `toolCallIndex` accepts the unscoped form as a second try.
    @MainActor
    func testToolCallIndexAcceptsUnscopedLegacyRowId() {
        let calls = [ToolCall(id: "call-1", name: "bash", input: nil)]

        XCTAssertEqual(
            AppState.toolCallIndex(
                in: calls, messageId: "reply", toolName: "bash", toolCallId: "call-1"),
            0)
    }

    @MainActor
    func testTurnEndSettlesAfterContentDone() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(
            .contentDone(messageId: "reply", model: nil, usage: nil),
            scoopJid: "cone", to: state)

        try send(.turnEnd(messageId: "reply"), scoopJid: "cone", to: state)

        XCTAssertFalse(state.isStreaming)
        XCTAssertNil(state.streamingMessageId)
        XCTAssertEqual(try XCTUnwrap(state.messages.last).isStreaming, false)
    }

    @MainActor
    func testAgentErrorSettlesVisibleTrackedTurn() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)

        try send(.error(error: "boom"), scoopJid: "cone", to: state)

        XCTAssertFalse(state.isStreaming)
        XCTAssertNil(state.streamingMessageId)
        XCTAssertEqual(state.leaderError, "boom")
        XCTAssertEqual(try XCTUnwrap(state.messages.last).isStreaming, false)
        XCTAssertEqual(try XCTUnwrap(state.messagesByScoop["cone"]?.last).isStreaming, false)
    }

    @MainActor
    func testBackgroundAgentErrorDoesNotRelatchWhenSelected() throws {
        let state = AppState()
        state.scoops = [
            ScoopSummary(
                jid: "cone", name: "cone", folder: "/workspace", isCone: true,
                assistantLabel: "sliccy", trigger: nil, state: nil, fill: nil),
            ScoopSummary(
                jid: "scoop", name: "scoop", folder: "/scoops/scoop", isCone: false,
                assistantLabel: "scoop", trigger: nil, state: nil, fill: nil),
        ]
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "cone-reply"), scoopJid: "cone", to: state)
        try send(.messageStart(messageId: "scoop-reply"), scoopJid: "scoop", to: state)

        try send(.error(error: "boom"), scoopJid: "scoop", to: state)

        XCTAssertTrue(state.isStreaming)
        XCTAssertEqual(state.streamingMessageId, "cone-reply")
        XCTAssertEqual(try XCTUnwrap(state.messagesByScoop["scoop"]?.last).isStreaming, false)

        state.selectScoop(jid: "scoop")

        XCTAssertFalse(state.isStreaming)
        XCTAssertNil(state.streamingMessageId)
        XCTAssertEqual(try XCTUnwrap(state.messages.last).isStreaming, false)
    }

    @MainActor
    func testBackgroundContentDoneDoesNotSettleVisibleTurn() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(.messageStart(messageId: "reply"), scoopJid: "scoop", to: state)

        try send(
            .contentDone(messageId: "reply", model: nil, usage: nil),
            scoopJid: "scoop", to: state)

        XCTAssertTrue(state.isStreaming)
        XCTAssertEqual(state.streamingMessageId, "reply")
    }

    @MainActor
    func testReadyStatusSettlesCompletedMessageWithoutTurnEnd() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"

        try sendStatus("processing", scoopJid: "cone", to: state)
        XCTAssertTrue(state.isStreaming)
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(
            .contentDone(messageId: "reply", model: nil, usage: nil),
            scoopJid: "cone", to: state)
        XCTAssertTrue(state.isStreaming)
        XCTAssertEqual(state.streamingMessageId, "reply")

        try sendStatus("ready", scoopJid: "cone", to: state)
        XCTAssertFalse(state.isStreaming)
        XCTAssertNil(state.streamingMessageId)
        XCTAssertEqual(try XCTUnwrap(state.messages.last).isStreaming, false)
    }

    @MainActor
    func testStatusForNonSelectedScoopDoesNotChangeVisibleStreamingState() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"

        try sendStatus("processing", scoopJid: "scoop", to: state)
        XCTAssertFalse(state.isStreaming)

        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try sendStatus("ready", scoopJid: "scoop", to: state)
        XCTAssertTrue(state.isStreaming)
        XCTAssertEqual(state.streamingMessageId, "reply")
    }

    @MainActor
    func testLegacyUnscopedReadyStatusIsApplied() throws {
        let state = AppState()
        state.selectedScoopJid = "cone"
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)

        state.handleDataChannelMessage(Data(#"{"type":"status","scoopStatus":"ready"}"#.utf8))

        XCTAssertFalse(state.isStreaming)
        XCTAssertNil(state.streamingMessageId)
    }
}
