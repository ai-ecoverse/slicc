import XCTest

@testable import SliccFollower
@testable import SliccTrayKit




@MainActor
final class UserMessageAckTests: XCTestCase {
    private func ack(_ id: String, state: String, error: String? = nil) -> Data {
        let errorField = error.map { #","error":"\#($0)""# } ?? ""
        return Data(
            #"{"type":"user_message_ack","messageId":"\#(id)","scoopJid":"cone-a","state":"\#(state)"\#(errorField)}"#
                .utf8)
    }

    private func snapshot(_ scoopJid: String, ids: [String]) -> Data {
        let rows = ids.map {
            #"{"id":"\#($0)","role":"assistant","content":"earlier","timestamp":1}"#
        }.joined(separator: ",")
        return Data(#"{"type":"snapshot","scoopJid":"\#(scoopJid)","messages":[\#(rows)]}"#.utf8)
    }

    
    
    private func stateWithDeliveredSend(id: String = "m1") -> AppState {
        let state = AppState()
        let message = ChatMessage(id: id, role: .user, content: "do it", timestamp: 1)
        state.selectedScoopJid = "cone-a"
        state.messagesByScoop = ["cone-a": [message]]
        state.messages = [message]
        state.localSends.record(message, scoopJid: "cone-a")
        return state
    }

    func testARejectedAckFlagsTheBubbleAndKeepsTheLeadersReason() {
        let state = stateWithDeliveredSend()

        state.handleDataChannelMessage(ack("m1", state: "rejected", error: "kernel unavailable"))

        XCTAssertEqual(state.messages.last?.error, true)
        XCTAssertEqual(state.messagesByScoop["cone-a"]?.last?.error, true)
        XCTAssertEqual(state.deliveryRejections["m1"], "kernel unavailable")
    }

    func testARejectedSendStaysFlaggedThroughASnapshotThatLacksIt() {
        let state = stateWithDeliveredSend()
        state.handleDataChannelMessage(ack("m1", state: "rejected", error: "no unit"))

        state.handleDataChannelMessage(snapshot("cone-a", ids: ["a1"]))

        XCTAssertEqual(state.messages.map(\.id), ["a1", "m1"])
        XCTAssertEqual(state.messages.last?.error, true, "the ledger re-applies the flagged copy")
        XCTAssertEqual(state.deliveryRejections["m1"], "no unit")
    }

    func testARejectedAckWithoutAnErrorStillExplainsItself() {
        let state = stateWithDeliveredSend()

        state.handleDataChannelMessage(ack("m1", state: "rejected"))

        XCTAssertEqual(state.deliveryRejections["m1"], AppState.genericDeliveryRejection)
        XCTAssertEqual(state.messages.last?.error, true)
    }

    func testARejectedAckFindsASendHeldInAnotherUnitsBuffer() {
        let state = stateWithDeliveredSend()
        
        state.selectedScoopJid = "cone-b"
        state.messages = []

        state.handleDataChannelMessage(ack("m1", state: "rejected", error: "gone"))

        XCTAssertEqual(state.messagesByScoop["cone-a"]?.last?.error, true)
        XCTAssertEqual(state.deliveryRejections["m1"], "gone")
    }

    func testAnAcceptedAckChangesNothingAndKeepsTheLedgerHold() {
        let state = stateWithDeliveredSend()

        state.handleDataChannelMessage(ack("m1", state: "accepted"))

        XCTAssertNil(state.messages.last?.error)
        XCTAssertTrue(state.deliveryRejections.isEmpty)
        XCTAssertTrue(state.localSends.owns("m1"), "only a snapshot confirms a send")
        
        state.handleDataChannelMessage(snapshot("cone-a", ids: ["a1"]))
        XCTAssertEqual(state.messages.map(\.id), ["a1", "m1"])
    }

    func testAnAckWithAnUnknownStateIsIgnored() {
        let state = stateWithDeliveredSend()

        state.handleDataChannelMessage(ack("m1", state: "queued", error: "later"))

        XCTAssertNil(state.messages.last?.error)
        XCTAssertTrue(state.deliveryRejections.isEmpty)
    }

    func testTheRejectionReasonInvalidatesItsRow() {
        let message = ChatMessage(id: "m1", role: .user, content: "do it", timestamp: 1, error: true)
        XCTAssertNotEqual(
            MessageBubble(message: message),
            MessageBubble(message: message, deliveryError: "kernel unavailable"),
            "a reason arriving after the flag must repaint the row")
    }
}
