import Foundation
import SliccTrayKit
import SliccWidgetKit
import XCTest

@testable import SliccFollower

/// The projection from `ScoopSummary` onto `WidgetUnit`. Everything the widget
/// will ever show is decided here, so the losses have to be the intended ones.
final class ScoopSummaryWidgetUnitTests: XCTestCase {
    private func summary(
        jid: String = "j1",
        name: String = "boy-scout",
        isCone: Bool = false,
        parentId: String? = "cone",
        assistantLabel: String = "boy-scout",
        state: String? = "working",
        activity: String? = "tool",
        fill: Double? = 42,
        trigger: String? = nil,
        model: ScoopSummaryModel? = nil
    ) -> ScoopSummary {
        ScoopSummary(
            jid: jid, name: name, folder: "/x", isCone: isCone,
            assistantLabel: assistantLabel, trigger: trigger, state: state,
            activity: activity, fill: fill, parentId: parentId, model: model)
    }

    func testTheOwnershipEdgeDecidesTheRole() {
        XCTAssertEqual(summary(parentId: "cone").widgetUnit(isActive: false).role, .scoop)
        XCTAssertEqual(
            summary(isCone: true, parentId: nil).widgetUnit(isActive: false).role, .cone)
        XCTAssertEqual(
            summary(isCone: false, parentId: nil).widgetUnit(isActive: false).role, .scoop,
            "a leader that predates the edge falls back to isCone, and this one says false")
    }

    func testLifecycleAndActivityCrossTheBoundaryIntact() {
        let unit = summary(state: "working", activity: "tool").widgetUnit(isActive: true)
        XCTAssertEqual(unit.lifecycle, .working)
        XCTAssertEqual(unit.activity, .tool)
        XCTAssertTrue(unit.isActive)
    }

    /// A refinement this build does not recognise must cost the refinement,
    /// not the unit — the same escape hatch the app applies everywhere else.
    func testAnUnknownActivityFallsBackToTheLifecycleAlone() {
        let unit = summary(state: "working", activity: "vibing").widgetUnit(isActive: false)
        XCTAssertEqual(unit.lifecycle, .working)
        XCTAssertNil(unit.activity)
    }

    func testAnUnknownLifecycleDegradesTheUnitRatherThanTheSnapshot() {
        let unit = summary(state: "hibernating", activity: nil).widgetUnit(isActive: false)
        XCTAssertEqual(unit.lifecycle, .unknown)
    }

    func testAnAbsentStateIsUnknownNotIdle() {
        XCTAssertEqual(summary(state: nil).widgetUnit(isActive: false).lifecycle, .unknown)
    }

    func testFillCrossesClampedAndModelLosesItsProvider() {
        let unit = summary(fill: 140, model: ScoopSummaryModel(provider: "anthropic", id: "opus"))
            .widgetUnit(isActive: false)
        XCTAssertEqual(unit.fill, 100)
        XCTAssertEqual(unit.model, "opus", "the provider half stays behind")
    }

    /// A trigger can be an entire user turn. A home screen is not a place to
    /// park one, so the capture side flattens and truncates it.
    func testTheTriggerIsFlattenedAndTruncated() {
        let long = "**fix** the [thing](https://x.test) " + String(repeating: "and more ", count: 60)
        let unit = summary(trigger: long).widgetUnit(isActive: false)
        XCTAssertLessThanOrEqual(unit.detail?.count ?? 0, 120)
        XCTAssertEqual(unit.detail?.hasPrefix("fix the thing and more"), true)
        XCTAssertNil(summary(trigger: nil).widgetUnit(isActive: false).detail)
    }

    /// The label is what the user reads; the folder-ish `name` is the fallback
    /// only when the leader sent no label at all.
    func testTheAssistantLabelNamesTheUnit() {
        XCTAssertEqual(
            summary(name: "folder-name", assistantLabel: "Researcher")
                .widgetUnit(isActive: false).name, "Researcher")
        XCTAssertEqual(
            summary(name: "folder-name", assistantLabel: "").widgetUnit(isActive: false).name,
            "folder-name")
    }
}

@MainActor
final class AppStateWidgetSnapshotTests: XCTestCase {
    private func makeState() -> AppState {
        let state = AppState()
        state.scoops = [
            ScoopSummary(
                jid: "cone", name: "cone", folder: "/", isCone: true, assistantLabel: "Sliccy",
                state: "working", activity: "thinking", fill: 12, parentId: nil),
            ScoopSummary(
                jid: "s1", name: "s1", folder: "/s", isCone: false, assistantLabel: "boy-scout",
                state: "broken", fill: 3, parentId: "cone"),
        ]
        state.leaderActiveScoopJid = "cone"
        state.selectedScoopJid = "cone"
        return state
    }

    func testTheSnapshotCarriesEveryUnitAndMarksTheActiveOne() {
        let snapshot = makeState().widgetSnapshot()
        XCTAssertEqual(snapshot.units.map(\.id), ["cone", "s1"])
        XCTAssertEqual(snapshot.units.first(where: \.isActive)?.id, "cone")
        XCTAssertEqual(snapshot.brokenCount, 1)
    }

    /// Never the join URL, which is a secret.
    func testTheInstanceLabelPrefersTheNameAndNeverLeaksTheJoinUrl() {
        let state = makeState()
        state.joinUrl = "https://tray.example.test/join/SECRET"
        XCTAssertEqual(state.widgetSnapshot().instanceLabel, "tray.example.test")

        state.activeDisplayName = "trieloff's Chrome"
        let snapshot = state.widgetSnapshot()
        XCTAssertEqual(snapshot.instanceLabel, "trieloff's Chrome")
        XCTAssertFalse(snapshot.instanceLabel.contains("SECRET"))
    }

    func testAnUnjoinedDeviceReportsNoInstanceRatherThanDisconnected() {
        let state = AppState()
        XCTAssertEqual(state.widgetSnapshot().connection, .none)
        XCTAssertTrue(state.widgetSnapshot().isUnavailable)

        state.activeDisplayName = "somewhere"
        XCTAssertEqual(state.widgetSnapshot().connection, .disconnected)
    }

    /// Half a sentence on a home screen reads as a bug, and the turn-end
    /// publish is a moment away.
    func testAStreamingTurnIsSkipped() {
        let state = makeState()
        state.messages = [
            ChatMessage(id: "1", role: .assistant, content: "settled", timestamp: 1000),
            ChatMessage(
                id: "2", role: .assistant, content: "half a sen", timestamp: 2000,
                isStreaming: true),
        ]
        XCTAssertEqual(state.widgetSnapshot().lastMessage?.text, "settled")
    }

    func testTheLastTurnIsFlattenedAndAttributed() {
        let state = makeState()
        state.messages = [
            ChatMessage(
                id: "1", role: .assistant,
                content: "**Done** — see [the PR](https://x.test)\n\n```swift\nlet x = 1\n```",
                timestamp: 1_787_000_000_000)
        ]
        let message = state.widgetSnapshot().lastMessage
        XCTAssertEqual(message?.text, "Done — see the PR")
        XCTAssertEqual(message?.author, .agent)
        XCTAssertEqual(message?.unitId, "cone")
    }

    func testAUserTurnIsAttributedToNoUnit() {
        let state = makeState()
        state.messages = [
            ChatMessage(id: "1", role: .user, content: "hold off", timestamp: 1000)
        ]
        XCTAssertEqual(state.widgetSnapshot().lastMessage?.author, .user)
        XCTAssertNil(state.widgetSnapshot().lastMessage?.unitId)
    }

    /// A turn with nothing printable left after flattening — a bare code block,
    /// a lone image — is not a preview.
    func testATurnThatFlattensToNothingIsNotThePreview() {
        let state = makeState()
        state.messages = [
            ChatMessage(id: "1", role: .assistant, content: "the real one", timestamp: 1000),
            ChatMessage(id: "2", role: .assistant, content: "```\njust code\n```", timestamp: 2000),
        ]
        XCTAssertEqual(state.widgetSnapshot().lastMessage?.text, "the real one")
    }

    func testAnEmptyTranscriptCarriesNoMessage() {
        XCTAssertNil(makeState().widgetSnapshot().lastMessage)
    }

    // MARK: Connection

    /// The widget reads the SETTLED health, so a blip the user never saw
    /// cannot flap the tile — and a stall that outlives the hold must reach it.
    func testTheSnapshotFollowsTheSettledHealthNotTheRawState() {
        let state = makeState()
        state.activeDisplayName = "Chrome"
        state.connectionState = .connected
        XCTAssertEqual(state.widgetSnapshot().connection, .connected)

        // A stall starts the hold; the settled value has not moved yet.
        state.isLeaderStalled = true
        XCTAssertEqual(
            state.widgetSnapshot().connection, .connected,
            "the settle hold exists so a blip does not reach the tile")

        // Once it settles, the widget has to see it — this is the state that
        // used to stick at `connected` forever, because the observers
        // published before the hold and the hold published nothing.
        state.settleConnectionImmediately()
        XCTAssertEqual(state.widgetSnapshot().connection, .stalled)
    }

    /// Detach clears the store LAST. Clearing it early let the connection
    /// observers republish off units and credentials still in memory, leaving
    /// a session the user walked away from named on the home screen.
    func testDetachLeavesNothingBehind() {
        let state = makeState()
        state.activeDisplayName = "Chrome"
        state.connectionState = .connected
        state.disconnect()

        XCTAssertTrue(state.scoops.isEmpty)
        let snapshot = state.widgetSnapshot()
        XCTAssertTrue(snapshot.units.isEmpty, "a detached session left its units behind")
        XCTAssertEqual(snapshot.instanceLabel, "SLICC", "the old instance is still named")

        // The connection field lags by the settle hold even here: a
        // user-initiated disconnect goes through the same window as a blip, so
        // for two seconds the app still reads `connected`. That is the app's
        // rule, not the widget's, and the store has been cleared regardless.
        XCTAssertEqual(snapshot.connection, .connected)
        state.settleConnectionImmediately()
        XCTAssertTrue(state.widgetSnapshot().isUnavailable)
    }
}
