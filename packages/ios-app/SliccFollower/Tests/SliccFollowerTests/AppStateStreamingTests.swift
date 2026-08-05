import Foundation
import SliccTrayKit
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

        state.handleDataChannelMessage(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.status(scoopStatus: "processing", scoopJid: "cone")))
        XCTAssertTrue(state.isStreaming)
        try send(.messageStart(messageId: "reply"), scoopJid: "cone", to: state)
        try send(
            .contentDone(messageId: "reply", model: nil, usage: nil),
            scoopJid: "cone", to: state)
        XCTAssertTrue(state.isStreaming)
        XCTAssertEqual(state.streamingMessageId, "reply")

        state.handleDataChannelMessage(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.status(scoopStatus: "ready", scoopJid: "cone")))
        XCTAssertFalse(state.isStreaming)
        XCTAssertNil(state.streamingMessageId)
        XCTAssertEqual(try XCTUnwrap(state.messages.last).isStreaming, false)
    }
}
