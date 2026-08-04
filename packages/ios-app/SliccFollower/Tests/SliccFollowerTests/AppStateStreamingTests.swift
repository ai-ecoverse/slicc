import Foundation
import XCTest

@testable import SliccFollower

final class AppStateStreamingTests: XCTestCase {
    @MainActor
    private func send(_ event: AgentEvent, scoopJid: String, to state: AppState) throws {
        let message = LeaderToFollowerMessage.agentEvent(event: event, scoopJid: scoopJid)
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

        state.handleDataChannelMessage(
            try JSONEncoder().encode(LeaderToFollowerMessage.status(scoopStatus: "processing")))
        XCTAssertTrue(state.isStreaming)
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(
            .contentDone(messageId: "reply", model: nil, usage: nil),
            scoopJid: "cone", to: state)
        XCTAssertTrue(state.isStreaming)
        XCTAssertEqual(state.streamingMessageId, "reply")

        state.handleDataChannelMessage(
            try JSONEncoder().encode(LeaderToFollowerMessage.status(scoopStatus: "ready")))
        XCTAssertFalse(state.isStreaming)
        XCTAssertNil(state.streamingMessageId)
        XCTAssertEqual(try XCTUnwrap(state.messages.last).isStreaming, false)
    }
}
