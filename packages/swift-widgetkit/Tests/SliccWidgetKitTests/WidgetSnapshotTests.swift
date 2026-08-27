import Foundation
import XCTest

@testable import SliccWidgetKit

final class WidgetSnapshotTests: XCTestCase {
    func testPrimaryConePrefersTheActiveRoot() {
        let snapshot = WidgetSnapshot(
            instanceLabel: "x", connection: .connected, capturedAt: .distantPast,
            units: [
                WidgetUnit(id: "a", name: "A", role: .cone),
                WidgetUnit(id: "b", name: "B", role: .cone, isActive: true),
            ])
        XCTAssertEqual(snapshot.primaryCone?.id, "b")
    }

    func testPrimaryConeFallsBackToTheFirstRoot() {
        let snapshot = WidgetSnapshot(
            instanceLabel: "x", connection: .connected, capturedAt: .distantPast,
            units: [
                WidgetUnit(id: "a", name: "A", role: .cone),
                WidgetUnit(id: "s", name: "S", role: .scoop, parentId: "a"),
            ])
        XCTAssertEqual(snapshot.primaryCone?.id, "a")
    }

    func testScoopsOwnedByFallsBackWhenTheEdgeIsAbsent() {
        let cone = WidgetUnit(id: "a", name: "A", role: .cone)
        let snapshot = WidgetSnapshot(
            instanceLabel: "x", connection: .connected, capturedAt: .distantPast,
            units: [cone, WidgetUnit(id: "s", name: "S", role: .scoop)])
        XCTAssertEqual(snapshot.scoops(ownedBy: cone).map(\.id), ["s"])
    }

    func testBusyAndBrokenCounts() {
        let snapshot = WidgetSnapshot.fixtureBusy
        XCTAssertEqual(snapshot.busyCount, 3)
        XCTAssertEqual(snapshot.brokenCount, 1)
    }

    func testAnythingButAConnectedChannelReadsAsStale() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        let live = WidgetSnapshot(
            instanceLabel: "x", connection: .connected, capturedAt: now, units: [])
        XCTAssertFalse(live.isStale(asOf: now))
        XCTAssertTrue(live.isStale(asOf: now.addingTimeInterval(WidgetSnapshot.stalenessHorizon + 1)))

        let stalled = WidgetSnapshot(
            instanceLabel: "x", connection: .stalled, capturedAt: now, units: [])
        XCTAssertTrue(stalled.isStale(asOf: now), "a stalled leader is stale the moment it stalls")
    }

    func testUnavailableIsNotJustAnEmptyUnitList() {
        let connectedButEmpty = WidgetSnapshot(
            instanceLabel: "x", connection: .connected, capturedAt: .distantPast, units: [])
        XCTAssertFalse(
            connectedButEmpty.isUnavailable,
            "connected with no cone yet is a real state, not an absent instance")
        XCTAssertTrue(WidgetSnapshot.unavailable().isUnavailable)
    }

    func testFillIsClampedAndNonFiniteBecomesZero() {
        XCTAssertEqual(WidgetUnit(id: "a", name: "A", role: .cone, fill: 140).fill, 100)
        XCTAssertEqual(WidgetUnit(id: "a", name: "A", role: .cone, fill: -3).fill, 0)
        XCTAssertEqual(WidgetUnit(id: "a", name: "A", role: .cone, fill: .nan).fill, 0)
        XCTAssertNil(WidgetUnit(id: "a", name: "A", role: .cone).fill)
    }

    func testNearLimitMatchesTheAppThreshold() {
        XCTAssertFalse(WidgetUnit(id: "a", name: "A", role: .scoop, fill: 74.9).isNearLimit)
        XCTAssertTrue(WidgetUnit(id: "a", name: "A", role: .scoop, fill: 75).isNearLimit)
    }

    func testStatusWordCoversEveryLifecycleAndRefinement() {
        func word(_ lifecycle: WidgetUnit.Lifecycle, _ activity: WidgetUnit.Activity?) -> String {
            WidgetUnit(id: "a", name: "A", role: .scoop, lifecycle: lifecycle, activity: activity)
                .statusWord
        }
        XCTAssertEqual(word(.working, .thinking), "thinking")
        XCTAssertEqual(word(.working, .tool), "running a tool")
        XCTAssertEqual(word(.working, nil), "thinking", "a turn always opens in thinking")
        XCTAssertEqual(word(.initializing, nil), "starting")
        XCTAssertEqual(word(.broken, nil), "needs you")
        XCTAssertEqual(word(.idle, .awaiting), "your turn")
        XCTAssertEqual(word(.idle, nil), "idle")
        XCTAssertEqual(word(.unknown, nil), "unknown")
    }

    func testOnlyTheTwoWordStatusShortens() {
        for lifecycle in WidgetUnit.Lifecycle.allCases {
            for activity in [WidgetUnit.Activity?.none] + WidgetUnit.Activity.allCases.map({ $0 }) {
                let unit = WidgetUnit(
                    id: "a", name: "A", role: .scoop, lifecycle: lifecycle, activity: activity)
                if lifecycle == .working && activity == .tool {
                    XCTAssertEqual(unit.shortStatusWord, "tool")
                } else {
                    XCTAssertEqual(unit.shortStatusWord, unit.statusWord)
                }
            }
        }
    }
}
