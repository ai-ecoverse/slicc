import Foundation
import SliccTrayKit
import XCTest

@testable import SliccFollower




final class ReadOnlyScoopTests: XCTestCase {
    private func cone(
        jid: String = "cone", parentId: String? = nil, isCone: Bool? = true
    ) -> ScoopSummary {
        ScoopSummary(
            jid: jid, name: "cone", folder: "/workspace", isCone: isCone,
            assistantLabel: "sliccy", trigger: nil, state: nil, fill: nil, parentId: parentId)
    }

    private func scoop(
        jid: String = "reviewer", parentId: String? = "cone", isCone: Bool? = false
    ) -> ScoopSummary {
        ScoopSummary(
            jid: jid, name: jid, folder: "/scoops/\(jid)", isCone: isCone,
            assistantLabel: jid, trigger: nil, state: nil, fill: nil, parentId: parentId)
    }

    

    func testOwnedUnitIsAScoopAndReadOnly() {
        let owned = scoop()
        XCTAssertFalse(owned.isRootUnit)
        XCTAssertEqual(owned.role, .scoop)
        XCTAssertTrue(owned.isReadOnly)
    }

    func testRootUnitIsAConeAndWritable() {
        let root = cone()
        XCTAssertTrue(root.isRootUnit)
        XCTAssertEqual(root.role, .cone)
        XCTAssertFalse(root.isReadOnly)
    }

    
    
    func testLegacyLeaderWithoutParentIdFallsBackToIsCone() {
        XCTAssertEqual(cone(parentId: nil, isCone: true).role, .cone)
        XCTAssertEqual(scoop(parentId: nil, isCone: false).role, .scoop)
        XCTAssertTrue(scoop(parentId: nil, isCone: false).isReadOnly)
    }

    
    
    func testOwnershipEdgeOutranksTheLegacyFlag() {
        XCTAssertEqual(scoop(parentId: "cone", isCone: true).role, .scoop)
    }

    
    
    
    func testRoleResolvesFromTheEdgeWhenIsConeIsAbsent() throws {
        XCTAssertEqual(cone(parentId: nil, isCone: nil).role, .cone)
        XCTAssertFalse(cone(parentId: nil, isCone: nil).isReadOnly)
        XCTAssertEqual(scoop(parentId: "cone", isCone: nil).role, .scoop)
        XCTAssertTrue(scoop(parentId: "cone", isCone: nil).isReadOnly)

        let decoder = JSONDecoder()
        let root = try decoder.decode(
            ScoopSummary.self,
            from: Data(
                #"{"jid":"c","name":"Cone","folder":"cone","assistantLabel":"sliccy","parentId":null}"#
                    .utf8))
        XCTAssertEqual(root.role, .cone)
        let child = try decoder.decode(
            ScoopSummary.self,
            from: Data(
                #"{"jid":"r","name":"reviewer","folder":"/scoops/r","assistantLabel":"r","parentId":"c"}"#
                    .utf8))
        XCTAssertEqual(child.role, .scoop)
        XCTAssertTrue(child.isReadOnly)
    }

    func testScoopOfAScoopStaysReadOnly() {
        XCTAssertTrue(scoop(jid: "grandchild", parentId: "reviewer").isReadOnly)
    }

    

    @MainActor
    func testComposerIsHiddenForASelectedScoopAndShownForACone() {
        let state = AppState()
        state.scoops = [cone(), scoop()]

        state.selectedScoopJid = "cone"
        XCTAssertFalse(state.selectedUnitIsReadOnly, "A cone keeps its composer")

        state.selectedScoopJid = "reviewer"
        XCTAssertTrue(state.selectedUnitIsReadOnly, "A scoop renders read-only")
    }

    
    
    @MainActor
    func testUnknownSelectionKeepsTheComposer() {
        let state = AppState()
        state.scoops = [cone()]
        state.selectedScoopJid = "not-in-the-roster"
        XCTAssertFalse(state.selectedUnitIsReadOnly)

        state.selectedScoopJid = nil
        XCTAssertFalse(state.selectedUnitIsReadOnly)
    }

    @MainActor
    func testLegacyRosterWithoutParentIdStillHidesTheComposerForAScoop() {
        let state = AppState()
        state.scoops = [cone(parentId: nil), scoop(parentId: nil, isCone: false)]
        state.selectedScoopJid = "reviewer"
        XCTAssertTrue(state.selectedUnitIsReadOnly)
    }

    

    
    
    @MainActor
    func testSendMessageIsRefusedWhileAScoopIsSelected() {
        let state = AppState()
        state.scoops = [cone(), scoop()]
        state.selectedScoopJid = "reviewer"

        state.sendMessage("please stop")

        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertNil(state.messagesByScoop["reviewer"])
    }

    @MainActor
    func testSendMessageStillWorksForACone() {
        let state = AppState()
        state.scoops = [cone(), scoop()]
        state.selectedScoopJid = "cone"

        state.sendMessage("carry on")

        XCTAssertEqual(state.messages.last?.content, "carry on")
        XCTAssertEqual(state.messagesByScoop["cone"]?.count, 1)
    }

    

    
    
    
    @MainActor
    func testToolUiForAScoopNeverMountsACard() throws {
        let state = AppState()
        state.scoops = [cone(), scoop()]
        state.selectedScoopJid = "cone"

        try send(
            .toolUI(
                messageId: "m1", toolName: "approve", requestId: "r1",
                html: "<button>ok</button>"),
            scoopJid: "reviewer", to: state)
        XCTAssertTrue(state.toolUICards.isEmpty)

        state.selectScoop(jid: "reviewer")
        XCTAssertTrue(state.toolUICards.isEmpty)
    }

    
    
    
    @MainActor
    func testAConesPendingCardIsHiddenWhileAScoopIsSelected() throws {
        let state = AppState()
        state.scoops = [cone(), scoop()]
        state.selectedScoopJid = "cone"
        try send(
            .toolUI(
                messageId: "m1", toolName: "approve", requestId: "r1",
                html: "<button>ok</button>"),
            scoopJid: "cone", to: state)
        XCTAssertEqual(state.visibleToolUICards.map(\.id), ["r1"])

        state.selectScoop(jid: "reviewer")
        XCTAssertTrue(state.visibleToolUICards.isEmpty)
        XCTAssertEqual(state.toolUICards.map(\.id), ["r1"], "The cone's card is hidden, not dropped")

        state.selectScoop(jid: "cone")
        XCTAssertEqual(state.visibleToolUICards.map(\.id), ["r1"])
    }

    @MainActor
    func testToolUiForAConeStillMountsACard() throws {
        let state = AppState()
        state.scoops = [cone(), scoop()]
        state.selectedScoopJid = "cone"

        try send(
            .toolUI(
                messageId: "m1", toolName: "approve", requestId: "r1",
                html: "<button>ok</button>"),
            scoopJid: "cone", to: state)

        XCTAssertEqual(state.toolUICards.map(\.id), ["r1"])
    }

    @MainActor
    private func send(_ event: AgentEvent, scoopJid: String, to state: AppState) throws {
        let message = LeaderToFollowerMessage.agentEvent(event: event, scoopJid: scoopJid)
        state.handleDataChannelMessage(try JSONEncoder().encode(message))
    }
}
