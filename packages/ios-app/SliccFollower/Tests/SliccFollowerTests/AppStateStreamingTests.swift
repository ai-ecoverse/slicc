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
