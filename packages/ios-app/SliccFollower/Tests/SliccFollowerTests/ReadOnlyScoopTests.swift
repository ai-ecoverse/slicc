import Foundation
import SliccTrayKit
import XCTest

@testable import SliccFollower

/// The read-only scoop view (#2367, parity with the webapp's #2312): a
/// selected scoop is the cone's work, not a conversation of its own, so the
/// composer and every interactive card belong to the cone that owns it.
final class ReadOnlyScoopTests: XCTestCase {
    private func cone(
        jid: String = "cone", parentId: String? = nil, isCone: Bool = true
    ) -> ScoopSummary {
        ScoopSummary(
            jid: jid, name: "cone", folder: "/workspace", isCone: isCone,
            assistantLabel: "sliccy", trigger: nil, state: nil, fill: nil, parentId: parentId)
    }

    private func scoop(
        jid: String = "reviewer", parentId: String? = "cone", isCone: Bool = false
    ) -> ScoopSummary {
        ScoopSummary(
            jid: jid, name: jid, folder: "/scoops/\(jid)", isCone: isCone,
            assistantLabel: jid, trigger: nil, state: nil, fill: nil, parentId: parentId)
    }

    // MARK: - The rule

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

    /// A leader that predates `parentId` sends no edge at all, so the legacy
    /// `isCone` flag settles that one case — and only that one.
    func testLegacyLeaderWithoutParentIdFallsBackToIsCone() {
        XCTAssertEqual(cone(parentId: nil, isCone: true).role, .cone)
        XCTAssertEqual(scoop(parentId: nil, isCone: false).role, .scoop)
        XCTAssertTrue(scoop(parentId: nil, isCone: false).isReadOnly)
    }

    /// The edge outranks the flag: anything owned is a scoop even if a leader
    /// contradicts itself, which is what makes `isCone` removable (#2358).
    func testOwnershipEdgeOutranksTheLegacyFlag() {
        XCTAssertEqual(scoop(parentId: "cone", isCone: true).role, .scoop)
    }

    func testScoopOfAScoopStaysReadOnly() {
        XCTAssertTrue(scoop(jid: "grandchild", parentId: "reviewer").isReadOnly)
    }

    // MARK: - View-model state

    @MainActor
    func testComposerIsHiddenForASelectedScoopAndShownForACone() {
        let state = AppState()
        state.scoops = [cone(), scoop()]

        state.selectedScoopJid = "cone"
        XCTAssertFalse(state.selectedUnitIsReadOnly, "A cone keeps its composer")

        state.selectedScoopJid = "reviewer"
        XCTAssertTrue(state.selectedUnitIsReadOnly, "A scoop renders read-only")
    }

    /// A selection the roster does not describe yet keeps the composer — the
    /// pre-multiple-cones default, re-asserted by the next `scoops.list`.
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

    // MARK: - Sending

    /// Dictation and the inbound-action paths reach `sendMessage` without a
    /// composer, so the read-only rule has to hold there too.
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

    // MARK: - Approval cards

    /// `tool_ui` for a scoop is routed to the owning cone by the leader
    /// (#2312); the follower refuses it anyway, keyed on the OWNING unit so
    /// switching tabs can never surface one either.
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

    /// A card the cone raised is held globally until the leader retracts it,
    /// so switching to a scoop must hide it — and switching back must not
    /// have lost it.
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
