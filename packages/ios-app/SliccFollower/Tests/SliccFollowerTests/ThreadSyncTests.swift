import XCTest

@testable import SliccFollower
@testable import SliccTrayKit

final class ThreadSyncPlannerTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    private func unit(
        _ jid: String, parent: String? = nil, state: String = "idle", turns: Double? = nil
    ) -> ScoopSummary {
        ScoopSummary(
            jid: jid, name: jid, folder: "/\(jid)", isCone: parent == nil, assistantLabel: jid,
            trigger: nil, state: state, fill: 10, parentId: parent, turns: turns)
    }

    private var roster: [ScoopSummary] {
        [unit("a"), unit("a-scoop", parent: "a"), unit("b"), unit("c")]
    }

    func testNothingIsPrefetchedFromALeaderThatWouldMoveTheSelection() {
        var planner = ThreadSyncPlanner()
        for version in [nil, 8] as [Int?] {
            XCTAssertNil(
                planner.next(roster: roster, selectedJid: "a", leaderVersion: version, now: start))
        }
    }

    func testNothingIsPrefetchedBeforeAUnitIsSelected() {
        var planner = ThreadSyncPlanner()
        XCTAssertNil(planner.next(roster: roster, selectedJid: nil, leaderVersion: 9, now: start))
    }

    func testUnitsAreFetchedOneAtATimeRootsFirstSkippingTheSelectedOne() {
        var planner = ThreadSyncPlanner()
        var order: [String] = []
        while let jid = planner.next(roster: roster, selectedJid: "a", leaderVersion: 9, now: start) {
            XCTAssertNil(
                planner.next(roster: roster, selectedJid: "a", leaderVersion: 9, now: start),
                "one request in flight at a time")
            order.append(jid)
            planner.snapshotArrived(for: jid)
        }
        XCTAssertEqual(order, ["b", "c", "a-scoop"])
    }

    func testAnUnansweredRequestGivesWayAfterTheTimeoutAndIsNotRetried() {
        var planner = ThreadSyncPlanner()
        XCTAssertEqual(planner.next(roster: roster, selectedJid: "a", leaderVersion: 9, now: start), "b")
        let late = start.addingTimeInterval(ThreadSyncPlanner.requestTimeout + 1)

        XCTAssertEqual(planner.next(roster: roster, selectedJid: "a", leaderVersion: 9, now: late), "c")
        planner.snapshotArrived(for: "c")
        XCTAssertEqual(
            planner.next(roster: roster, selectedJid: "a", leaderVersion: 9, now: late), "a-scoop")
    }

    func testAUnitThatFinishedATurnOffScreenIsFetchedAgain() {
        var planner = ThreadSyncPlanner()
        for jid in ["b", "c", "a-scoop"] { planner.snapshotArrived(for: jid) }
        let working = [unit("a"), unit("a-scoop", parent: "a"), unit("b", state: "working"), unit("c")]

        planner.rosterChanged(from: roster, to: working, selectedJid: "a")
        XCTAssertNil(
            planner.next(roster: working, selectedJid: "a", leaderVersion: 9, now: start),
            "a unit still working is not refetched mid-turn")

        planner.rosterChanged(from: working, to: roster, selectedJid: "a")
        XCTAssertEqual(planner.next(roster: roster, selectedJid: "a", leaderVersion: 9, now: start), "b")
    }

    /// The turn started and ended inside one coalescing window: both rosters
    /// say `idle`, and only the counter moved.
    func testATurnHiddenByCoalescingIsCaughtByTheCounter() {
        var planner = ThreadSyncPlanner()
        planner.snapshotArrived(for: "b")
        let before = [unit("a"), unit("b", turns: 3)]
        planner.rosterChanged(from: [], to: before, selectedJid: "a")
        XCTAssertTrue(planner.synced.contains("b"), "the first sighting is a baseline, not news")

        planner.rosterChanged(from: before, to: [unit("a"), unit("b", turns: 4)], selectedJid: "a")
        XCTAssertFalse(planner.synced.contains("b"))
    }

    func testAnUnchangedCounterKeepsTheBuffer() {
        var planner = ThreadSyncPlanner()
        planner.snapshotArrived(for: "b")
        let roster = [unit("a"), unit("b", turns: 3)]
        planner.rosterChanged(from: [], to: roster, selectedJid: "a")
        planner.rosterChanged(from: roster, to: roster, selectedJid: "a")
        XCTAssertTrue(planner.synced.contains("b"))
    }

    /// A leader reload restarts every counter at 0: refetch, then measure
    /// from the new value rather than waiting for it to pass the old one.
    func testADecreasingCounterRebaselinesAndRefetches() {
        var planner = ThreadSyncPlanner()
        planner.snapshotArrived(for: "b")
        let old = [unit("a"), unit("b", turns: 7)]
        planner.rosterChanged(from: [], to: old, selectedJid: "a")
        let reloaded = [unit("a"), unit("b", turns: 0)]
        planner.rosterChanged(from: old, to: reloaded, selectedJid: "a")
        XCTAssertFalse(planner.synced.contains("b"))

        planner.snapshotArrived(for: "b")
        planner.rosterChanged(from: reloaded, to: [unit("a"), unit("b", turns: 1)], selectedJid: "a")
        XCTAssertFalse(planner.synced.contains("b"), "the new baseline is 0, so 1 is a turn")
    }

    func testTheSelectedUnitsCounterDoesNotInvalidateIt() {
        var planner = ThreadSyncPlanner()
        planner.snapshotArrived(for: "b")
        planner.rosterChanged(from: [], to: [unit("b", turns: 1)], selectedJid: "b")
        planner.rosterChanged(
            from: [unit("b", turns: 1)], to: [unit("b", turns: 2)], selectedJid: "b")
        XCTAssertTrue(planner.synced.contains("b"))
    }

    func testTheSelectedUnitsOwnTurnDoesNotInvalidateIt() {
        var planner = ThreadSyncPlanner()
        planner.snapshotArrived(for: "b")
        let working = [unit("a"), unit("b", state: "working")]

        planner.rosterChanged(from: working, to: [unit("a"), unit("b")], selectedJid: "b")

        XCTAssertTrue(planner.synced.contains("b"), "the selected unit streams; its buffer is live")
    }

    func testTheCapTrimsScoopsBeforeCones() {
        var planner = ThreadSyncPlanner()
        let scoops = (0..<ThreadSyncPlanner.maxUnits).map { unit("s\($0)", parent: "a") }
        let big = [unit("a")] + scoops + [unit("z")]
        var fetched: [String] = []
        while let jid = planner.next(roster: big, selectedJid: "a", leaderVersion: 9, now: start) {
            fetched.append(jid)
            planner.snapshotArrived(for: jid)
        }
        XCTAssertEqual(fetched.first, "z", "a cone listed last still comes first")
        XCTAssertEqual(fetched.count, ThreadSyncPlanner.maxUnits - 1, "the selected unit holds one slot")
    }

    func testResetForgetsEverythingAndDroppedUnitsAreForgotten() {
        var planner = ThreadSyncPlanner()
        planner.snapshotArrived(for: "b")
        planner.rosterChanged(from: roster, to: [unit("a")], selectedJid: "a")
        XCTAssertFalse(planner.synced.contains("b"), "a unit that left the roster is forgotten")

        planner.snapshotArrived(for: "c")
        _ = planner.next(roster: roster, selectedJid: "a", leaderVersion: 9, now: start)
        planner.reset()
        XCTAssertTrue(planner.synced.isEmpty)
        XCTAssertNil(planner.inFlight)
    }
}

@MainActor
final class AppStateThreadSyncTests: XCTestCase {
    private func snapshot(_ scoopJid: String, ids: [String]) -> Data {
        let rows = ids.map {
            #"{"id":"\#($0)","role":"assistant","content":"x","timestamp":1}"#
        }.joined(separator: ",")
        return Data(#"{"type":"snapshot","scoopJid":"\#(scoopJid)","messages":[\#(rows)]}"#.utf8)
    }

    private func stateViewing(_ jid: String) -> AppState {
        let state = AppState()
        state.selectedScoopJid = jid
        let seen = ChatMessage(id: "a1", role: .assistant, content: "x", timestamp: 1)
        state.messagesByScoop = [jid: [seen]]
        state.messages = [seen]
        return state
    }

    func testABackgroundSnapshotFillsItsBufferAndLeavesTheViewedTranscriptAlone() {
        let state = stateViewing("cone-a")

        state.handleDataChannelMessage(snapshot("cone-b", ids: ["b1", "b2"]))

        XCTAssertEqual(state.messagesByScoop["cone-b"]?.map(\.id), ["b1", "b2"])
        XCTAssertEqual(state.messages.map(\.id), ["a1"])
        XCTAssertEqual(state.selectedScoopJid, "cone-a")
        XCTAssertTrue(state.threadSync.synced.contains("cone-b"))
    }

    func testABackgroundSnapshotDoesNotClearTheViewedConesApprovalCards() {
        let state = stateViewing("cone-a")
        state.toolUICards = [ToolUIPlaceholder(requestId: "r1", html: "<h3>Approve</h3>")]

        state.handleDataChannelMessage(snapshot("cone-b", ids: ["b1"]))
        XCTAssertEqual(state.toolUICards.map(\.id), ["r1"], "cone A's card is still A's")

        // The viewed unit's own snapshot is the leader re-describing it.
        state.handleDataChannelMessage(snapshot("cone-a", ids: ["a1"]))
        XCTAssertTrue(state.toolUICards.isEmpty)
    }

    func testAnEmptyBackgroundSnapshotDoesNotSettleANewSessionRequest() {
        let state = stateViewing("cone-a")
        state.newSessionInFlight = true

        state.handleDataChannelMessage(snapshot("fresh-cone", ids: []))

        XCTAssertTrue(state.newSessionInFlight, "an untouched cone is empty too")
    }
}
