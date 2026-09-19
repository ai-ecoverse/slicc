import SliccTrayKit
import XCTest

@testable import SliccFollower

final class ThreadListOrderTests: XCTestCase {
    func testScoopsNestUnderTheirOwningConeDepthFirstInLeaderOrder() {
        let roster = [
            scoop("a1", parent: "coneA"),
            cone("coneA"),
            scoop("b1", parent: "coneB"),
            scoop("a1x", parent: "a1"),
            cone("coneB"),
            scoop("a2", parent: "coneA"),
        ]
        let entries = ThreadListOrder.entries(roster)
        XCTAssertEqual(entries.map(\.id), ["coneA", "a1", "a1x", "a2", "coneB", "b1"])
        XCTAssertEqual(entries.map(\.depth), [0, 1, 2, 1, 0, 1])
    }

    func testUnknownOwnersTrailInLeaderOrder() {
        // A legacy leader: no edges at all, the scoops say `isCone: false`.
        let legacy = [
            ScoopSummary(jid: "x", name: "x", folder: "x", isCone: false, assistantLabel: "x"),
            cone("c"),
            scoop("orphan", parent: "gone"),
        ]
        let entries = ThreadListOrder.entries(legacy)
        XCTAssertEqual(entries.map(\.id), ["c", "x", "orphan"])
        XCTAssertEqual(entries.map(\.depth), [0, 1, 1])
    }

    func testACycleNeverSpinsAndEveryUnitIsListedOnce() {
        let roster = [cone("c"), scoop("p", parent: "q"), scoop("q", parent: "p")]
        XCTAssertEqual(ThreadListOrder.entries(roster).map(\.id), ["c", "p", "q"])
    }

    func testRootsSortOldestFirstOnlyWhenEveryRootIsStamped() {
        let roots = [cone("late"), cone("early"), cone("tie-b"), cone("tie-a")]
        let stamps = [
            "late": "2026-09-02", "early": "2026-09-01", "tie-b": "2026-09-03",
            "tie-a": "2026-09-03",
        ]
        XCTAssertEqual(
            ThreadListOrder.orderRoots(roots, addedAt: { stamps[$0.jid] }).map(\.jid),
            ["early", "late", "tie-a", "tie-b"])
        XCTAssertEqual(
            ThreadListOrder.orderRoots(roots, addedAt: { $0.jid == "late" ? nil : stamps[$0.jid] })
                .map(\.jid),
            ["late", "early", "tie-b", "tie-a"],
            "A partially stamped set keeps leader order")
        XCTAssertEqual(ThreadListOrder.orderRoots(roots).map(\.jid), roots.map(\.jid))
    }
}

final class ThreadListRowTests: XCTestCase {
    func testMarkersDeriveFromTheRosterAndSelection() {
        let roster = [
            cone(
                "main", label: "sliccy", state: "idle", activity: "awaiting", fill: 22,
                model: ScoopSummaryModel(provider: "anthropic", id: "claude-opus-4-6")),
            scoop("r", parent: "main", state: "working", activity: "tool", fill: 80),
            cone("deploy", label: "deploy-bot", state: "broken", fill: nil),
        ]
        let rows = ThreadListRow.rows(
            scoops: roster, selectedJid: "main", leaderActiveJid: "deploy",
            unread: ["deploy": 2, "main": 5, "r": 3])
        let main = rows[0]
        let researcher = rows[1]
        let deploy = rows[2]

        XCTAssertTrue(main.isSelected)
        XCTAssertEqual(main.unread, 0, "Selection is the read receipt")
        XCTAssertEqual(main.label, "sliccy")
        XCTAssertEqual(main.activityPhrase, "waiting for you")
        XCTAssertEqual(main.modelId, "claude-opus-4-6")
        XCTAssertFalse(main.isReadOnly)

        XCTAssertEqual(researcher.label, "r", "A scoop is labelled by its name, as on the web")
        XCTAssertEqual(researcher.role, .scoop)
        XCTAssertTrue(researcher.isReadOnly)
        XCTAssertEqual(researcher.unread, 0, "A scoop is never news")
        XCTAssertEqual(researcher.activityPhrase, "running a tool")
        XCTAssertEqual(researcher.fillText, "80%")
        XCTAssertTrue(researcher.status.isNearLimit)
        XCTAssertEqual(researcher.depth, 1)

        XCTAssertTrue(deploy.isLeaderActive)
        XCTAssertEqual(deploy.unread, 2)
        XCTAssertEqual(deploy.activityPhrase, "broken")
        XCTAssertNil(deploy.fillText, "Absent fill never reads as zero")
        XCTAssertEqual(
            deploy.accessibilityLabel,
            "deploy-bot: broken, context fill unknown · cone · active on leader · 2 unread turns")
        XCTAssertEqual(
            researcher.accessibilityLabel,
            "r: working, 80% context fill · running a tool · scoop · read-only")
    }

    func testPhrasesCoverEveryLifecycle() {
        let phrases = [
            ("working", nil, "thinking"), ("idle", nil, "idle"), ("initializing", nil, "starting"),
            ("mystery", nil, nil),
        ].map { state, activity, expected -> (String?, String?) in
            let row = ThreadListRow.rows(
                scoops: [cone("c", state: state, activity: activity)], selectedJid: nil,
                leaderActiveJid: nil, unread: [:])[0]
            return (row.activityPhrase, expected)
        }
        for (actual, expected) in phrases { XCTAssertEqual(actual, expected) }
    }

    func testTheSelectedRowWearsTheLocalExpression() {
        let roster = [cone("c", state: "working", activity: "thinking")]
        let local = ScoopSummary.LocalExpressionSignals(toolRunning: true)
        let selected = ThreadListRow.rows(
            scoops: roster, selectedJid: "c", leaderActiveJid: nil, unread: [:], local: local)
        let other = ThreadListRow.rows(
            scoops: roster, selectedJid: nil, leaderActiveJid: nil, unread: [:], local: local)
        XCTAssertEqual(selected[0].activity, .working)
        XCTAssertEqual(other[0].activity, .thinking)
    }
}

final class ThreadUnreadLedgerTests: XCTestCase {
    func testStateFallbackCountsAFinishedTurnOnAnUnselectedCone() {
        var ledger = ThreadUnreadLedger()
        XCTAssertEqual(ledger.sync([unit("a", .working), unit("b", .idle)], selectedId: "b"), [:])
        XCTAssertEqual(ledger.sync([unit("a", .idle), unit("b", .idle)], selectedId: "b"), ["a": 1])
        XCTAssertEqual(ledger.sync([unit("a", .idle), unit("b", .idle)], selectedId: "b"), ["a": 1])
        XCTAssertEqual(ledger.sync([unit("a", .idle), unit("b", .idle)], selectedId: "a"), [:])
    }

    func testScoopsAndFirstSightingsAreNeverNews() {
        var ledger = ThreadUnreadLedger()
        XCTAssertEqual(ledger.sync([unit("s", .working, root: false)], selectedId: nil), [:])
        XCTAssertEqual(ledger.sync([unit("s", .idle, root: false)], selectedId: nil), [:])
        XCTAssertEqual(ledger.sync([unit("c", .idle, turns: 7)], selectedId: nil), [:])
    }

    func testCounterDeltasWinAndAReloadRebaselines() {
        var ledger = ThreadUnreadLedger()
        _ = ledger.sync([unit("c", .idle)], selectedId: nil)
        XCTAssertEqual(ledger.sync([unit("c", .idle, turns: 2)], selectedId: nil), ["c": 2])
        XCTAssertEqual(ledger.sync([unit("c", .idle, turns: 0)], selectedId: nil), ["c": 2])
        XCTAssertEqual(ledger.sync([unit("c", .idle, turns: 1)], selectedId: nil), ["c": 3])
    }

    func testADroppedConeLosesItsCount() {
        var ledger = ThreadUnreadLedger()
        _ = ledger.sync([unit("c", .working)], selectedId: nil)
        XCTAssertEqual(ledger.sync([unit("c", .idle)], selectedId: nil), ["c": 1])
        XCTAssertEqual(ledger.sync([], selectedId: nil), [:])
        XCTAssertEqual(ledger.sync([unit("c", .idle)], selectedId: nil), [:])
    }

    func testUnitFromSummaryRunsTheStateFallback() {
        let unit = ThreadUnreadLedger.Unit(cone("c", state: "working"))
        XCTAssertEqual(unit, .init(id: "c", isRoot: true, lifecycle: .working, turns: nil))
    }

    private func unit(
        _ id: String, _ lifecycle: ScoopLifecycle, root: Bool = true, turns: Int? = nil
    ) -> ThreadUnreadLedger.Unit {
        .init(id: id, isRoot: root, lifecycle: lifecycle, turns: turns)
    }
}

final class ThreadListLayoutTests: XCTestCase {
    func testCompactIsAlwaysAnOverlay() {
        XCTAssertEqual(
            ThreadListLayout.presentation(
                shellMode: .compactOverlay, availableWidth: 2000, workbenchOpen: false),
            .overlay)
    }

    func testRegularKeepsASidebarUntilTheConversationWouldBeSqueezed() {
        func shape(_ width: CGFloat, workbench: Bool = false) -> ThreadListPresentation {
            ThreadListLayout.presentation(
                shellMode: .regularSplit, availableWidth: width, workbenchOpen: workbench)
        }
        // iPad 13" landscape and portrait.
        XCTAssertEqual(shape(1376), .sidebar)
        XCTAssertEqual(shape(1032), .sidebar)
        XCTAssertEqual(shape(1032, workbench: true), .sidebar)
        // iPad 11" portrait: room for the chat, not for chat + workbench.
        XCTAssertEqual(shape(834), .sidebar)
        XCTAssertEqual(shape(834, workbench: true), .overlay)
        // A half-width pane that still reports regular.
        XCTAssertEqual(shape(694), .overlay)
        XCTAssertEqual(shape(728), .sidebar)
    }

    func testTheSlideOverLeavesAStripOfConversation() {
        XCTAssertEqual(ThreadListLayout.overlayWidth(availableWidth: 402), 320)
        XCTAssertEqual(ThreadListLayout.overlayWidth(availableWidth: 320), 264)
        XCTAssertEqual(ThreadListLayout.overlayWidth(availableWidth: 10), 0)
    }
}

@MainActor
final class ThreadListModelTests: XCTestCase {
    func testTogglesAreScopedToTheirPresentation() {
        let model = ThreadListModel()
        XCTAssertFalse(model.isVisible(in: .overlay))
        XCTAssertTrue(model.isVisible(in: .sidebar))
        model.toggle(in: .overlay)
        XCTAssertTrue(model.isVisible(in: .overlay))
        model.toggle(in: .sidebar)
        XCTAssertFalse(model.isVisible(in: .sidebar))
        model.dismiss(in: .sidebar)
        XCTAssertTrue(model.isSidebarCollapsed)
        model.dismiss(in: .overlay)
        XCTAssertFalse(model.isOverlayOpen)
    }

    func testSelectingClosesOnlyTheSlideOver() {
        let model = ThreadListModel()
        model.isOverlayOpen = true
        model.didSelect(in: .sidebar)
        XCTAssertTrue(model.isOverlayOpen)
        model.didSelect(in: .overlay)
        XCTAssertFalse(model.isOverlayOpen)
    }

    func testWideningDropsALeftOverSlideOver() {
        let model = ThreadListModel()
        model.isOverlayOpen = true
        model.presentationChanged(to: .overlay)
        XCTAssertTrue(model.isOverlayOpen)
        model.presentationChanged(to: .sidebar)
        XCTAssertFalse(model.isOverlayOpen)
    }

    func testSyncPublishesUnreadForFinishedTurns() {
        let model = ThreadListModel()
        model.sync(scoops: [cone("a", state: "working"), cone("b")], selectedJid: "b")
        model.sync(scoops: [cone("a", state: "idle"), cone("b")], selectedJid: "b")
        XCTAssertEqual(model.unread, ["a": 1])
        model.sync(scoops: [cone("a", state: "idle"), cone("b")], selectedJid: "a")
        XCTAssertEqual(model.unread, [:])
    }
}

final class ScoopSwipeOrderTests: XCTestCase {
    @MainActor
    func testSwipeWalksTheThreadListOrder() {
        let state = AppState()
        state.scoops = [cone("a"), cone("b"), scoop("a1", parent: "a")]
        state.selectedScoopJid = "a"
        state.swipeToNextScoop()
        XCTAssertEqual(state.selectedScoopJid, "a1")
        state.swipeToNextScoop()
        XCTAssertEqual(state.selectedScoopJid, "b")
        state.swipeToPreviousScoop()
        XCTAssertEqual(state.selectedScoopJid, "a1")
    }
}

// MARK: - Fixtures

private func cone(
    _ jid: String, label: String? = nil, state: String? = "idle", activity: String? = nil,
    fill: Double? = 10, model: ScoopSummaryModel? = nil
) -> ScoopSummary {
    ScoopSummary(
        jid: jid, name: jid, folder: "/\(jid)", isCone: true, assistantLabel: label ?? jid,
        state: state, activity: activity, fill: fill, parentId: nil, model: model)
}

private func scoop(
    _ jid: String, parent: String, state: String? = "idle", activity: String? = nil,
    fill: Double? = 10
) -> ScoopSummary {
    ScoopSummary(
        jid: jid, name: jid, folder: "/scoops/\(jid)", isCone: false, assistantLabel: jid.uppercased(),
        state: state, activity: activity, fill: fill, parentId: parent)
}
