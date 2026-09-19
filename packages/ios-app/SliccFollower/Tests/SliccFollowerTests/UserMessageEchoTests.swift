import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

/// `user_message_echo` names a unit, and a leader older than the
/// delivered-unit tag names the WRONG one for a follower's own prompt: the
/// unit the leader is displaying, not the one the prompt went to.
@MainActor
final class UserMessageEchoTests: XCTestCase {
    private func echo(_ id: String, text: String, scoopJid: String) -> Data {
        Data(
            #"{"type":"user_message_echo","text":"\#(text)","messageId":"\#(id)","scoopJid":"\#(scoopJid)"}"#
                .utf8)
    }

    /// Sends through the real path, so the ledger holds what a send leaves.
    private func stateAfterSending(_ text: String, under scoopJid: String) throws -> (
        AppState, String
    ) {
        let state = AppState()
        state.selectedScoopJid = scoopJid
        state.messagesByScoop = ["cone-a": [], "cone-b": []]
        state.sendMessage(text)
        let id = try XCTUnwrap(state.messages.last?.id)
        return (state, id)
    }

    private func snapshot(_ scoopJid: String, ids: [String]) -> Data {
        let rows = ids.map {
            #"{"id":"\#($0)","role":"assistant","content":"earlier","timestamp":1}"#
        }.joined(separator: ",")
        return Data(#"{"type":"snapshot","scoopJid":"\#(scoopJid)","messages":[\#(rows)]}"#.utf8)
    }

    func testAnEchoOfOurOwnPromptIsNotAppendedToTheUnitTheLeaderDisplays() throws {
        let (state, id) = try stateAfterSending("for B", under: "cone-b")

        // The leader is displaying cone A and tags the echo accordingly.
        state.handleDataChannelMessage(echo(id, text: "for B", scoopJid: "cone-a"))

        XCTAssertEqual(
            state.messagesByScoop["cone-a"]?.map(\.id), [],
            "a prompt typed under B must not surface in A")
        XCTAssertEqual(state.messagesByScoop["cone-b"]?.map(\.id), [id])
        XCTAssertEqual(state.messages.map(\.id), [id])
    }

    func testASnapshotBuiltBeforeThePromptArrivedDoesNotEraseIt() throws {
        let (state, id) = try stateAfterSending("still here?", under: "cone-b")

        // Requested by the switch to B, built before the prompt reached the leader.
        state.handleDataChannelMessage(snapshot("cone-b", ids: ["a1", "a2"]))

        XCTAssertEqual(state.messages.map(\.id), ["a1", "a2", id])
        XCTAssertEqual(state.messagesByScoop["cone-b"]?.map(\.id), ["a1", "a2", id])
    }

    func testASnapshotThatContainsThePromptConfirmsItOnce() throws {
        let (state, id) = try stateAfterSending("confirmed", under: "cone-b")

        state.handleDataChannelMessage(snapshot("cone-b", ids: ["a1", id]))
        XCTAssertEqual(state.messages.map(\.id), ["a1", id], "no duplicate")

        // Confirmed means released: a later snapshot without it is the truth
        // (the leader compacted or cleared), not something to argue with.
        state.handleDataChannelMessage(snapshot("cone-b", ids: ["a1"]))
        XCTAssertEqual(state.messages.map(\.id), ["a1"])
    }

    func testAnotherDevicesPromptStillLandsInTheUnitItNames() {
        let state = AppState()
        state.selectedScoopJid = "cone-a"
        state.messagesByScoop = ["cone-a": []]

        state.handleDataChannelMessage(echo("m2", text: "from the desk", scoopJid: "cone-a"))

        XCTAssertEqual(state.messagesByScoop["cone-a"]?.map(\.content), ["from the desk"])
        XCTAssertEqual(state.messages.map(\.id), ["m2"], "the viewed unit renders it at once")
    }
}
