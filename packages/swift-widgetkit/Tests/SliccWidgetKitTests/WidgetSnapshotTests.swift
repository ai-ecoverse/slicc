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

    /// Units win over the connection field: a snapshot that HAS work units
    /// must never answer "No instance", however the two fields disagree.
    func testASnapshotWithUnitsIsNeverUnavailable() {
        for connection in [
            WidgetSnapshot.Connection.none, .disconnected, .stalled, .connected,
        ] {
            let snapshot = WidgetSnapshot(
                instanceLabel: "x", connection: connection, capturedAt: .distantPast,
                units: [WidgetUnit(id: "c", name: "C", role: .cone)])
            XCTAssertFalse(snapshot.isUnavailable, "\(connection) hid a unit it had")
        }
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

/// The preview flattener runs on BOTH capture sides, so it is tested once here
/// rather than twice badly.
final class WidgetMessageFlattenTests: XCTestCase {
    func testFencedCodeGoesEntirely() {
        let text = WidgetMessage.flatten(
            markdown: "Fixed it:\n\n```swift\nlet x = 1\nprint(x)\n```\n\nShip?")
        XCTAssertEqual(text, "Fixed it: Ship?")
        XCTAssertFalse(text.contains("print"))
    }

    func testInlineFormattingLosesItsMarkersButKeepsTheWords() {
        XCTAssertEqual(
            WidgetMessage.flatten(markdown: "**bold** and _italic_ and `code` and ~~gone~~"),
            "bold and italic and code and gone")
    }

    func testLinksKeepTheirTextAndImagesGoAway() {
        XCTAssertEqual(
            WidgetMessage.flatten(markdown: "see [the PR](https://example.com/1) now"),
            "see the PR now")
        XCTAssertEqual(
            WidgetMessage.flatten(markdown: "before ![a screenshot](x.png) after"),
            "before after")
    }

    func testBlockMarkersAreStripped() {
        XCTAssertEqual(
            WidgetMessage.flatten(markdown: "# Heading\n\n- one\n- two\n\n> quoted\n\n1. first"),
            "Heading one two quoted first")
    }

    func testHorizontalRulesDoNotSurviveAsPunctuation() {
        XCTAssertEqual(WidgetMessage.flatten(markdown: "a\n\n---\n\nb"), "a b")
    }

    func testEveryRunOfWhitespaceBecomesOneSpace() {
        XCTAssertEqual(WidgetMessage.flatten(markdown: "  a \n\n\n  b\t\tc  "), "a b c")
    }

    /// The cap is enforced by the flattener too, not only by the initializer —
    /// a capture side that builds the text by hand still cannot overrun it.
    func testTheResultIsCapped() {
        let long = String(repeating: "word ", count: 500)
        XCTAssertEqual(
            WidgetMessage.flatten(markdown: long).count, WidgetMessage.previewLimit)
    }

    func testEmptyAndWhitespaceOnlyTurnsFlattenToNothing() {
        XCTAssertEqual(WidgetMessage.flatten(markdown: ""), "")
        XCTAssertEqual(WidgetMessage.flatten(markdown: "\n\n   \n"), "")
        XCTAssertEqual(WidgetMessage.flatten(markdown: "```\nonly code\n```"), "")
    }
}
