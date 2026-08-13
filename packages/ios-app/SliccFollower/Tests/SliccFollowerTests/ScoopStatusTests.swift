import SliccTrayKit
import XCTest

@testable import SliccFollower

final class ScoopStatusTests: XCTestCase {
    func testLifecycleMapsEveryWireValueAndUnknowns() {
        XCTAssertEqual(ScoopLifecycle(state: "working"), .working)
        XCTAssertEqual(ScoopLifecycle(state: "thinking"), .thinking)
        XCTAssertEqual(ScoopLifecycle(state: "awaiting"), .awaiting)
        XCTAssertEqual(ScoopLifecycle(state: "broken"), .broken)
        XCTAssertEqual(ScoopLifecycle(state: "initializing"), .initializing)
        XCTAssertEqual(ScoopLifecycle(state: "idle"), .idle)
        // Absent (a leader older than the lifecycle fields) and unrecognised (a
        // leader newer than this build) both degrade to the same quiet floor.
        XCTAssertEqual(ScoopLifecycle(state: nil), .unknown)
        XCTAssertEqual(ScoopLifecycle(state: "future-state"), .unknown)
    }

    func testBusyCoversBothHalvesOfATurn() {
        XCTAssertTrue(ScoopLifecycle.working.isBusy)
        XCTAssertTrue(ScoopLifecycle.thinking.isBusy)
        for lifecycle in [ScoopLifecycle.awaiting, .idle, .broken, .initializing, .unknown] {
            XCTAssertFalse(lifecycle.isBusy, "\(lifecycle.rawValue) is not mid-turn")
        }
    }

    func testEveryLifecycleRawValueRoundTrips() {
        // CaseIterable + rawValue is what `ScoopLifecycle(state:)` decodes, so a
        // case added without a wire string would strand itself here.
        for lifecycle in ScoopLifecycle.allCases where lifecycle != .unknown {
            XCTAssertEqual(ScoopLifecycle(state: lifecycle.rawValue), lifecycle)
        }
    }

    func testFullnessPreservesAbsenceAndClampsPresentValues() {
        XCTAssertNil(ScoopStatus(state: "idle", fill: nil).fullness)
        XCTAssertEqual(ScoopStatus(state: "idle", fill: -1).fullness, 0)
        XCTAssertEqual(ScoopStatus(state: "idle", fill: 42).fullness, 42)
        XCTAssertEqual(ScoopStatus(state: "idle", fill: 101).fullness, 100)
    }

    func testNearLimitBoundaryMatchesWeb() {
        XCTAssertFalse(ScoopStatus(state: "working", fill: nil).isNearLimit)
        XCTAssertFalse(ScoopStatus(state: "working", fill: 74.999).isNearLimit)
        XCTAssertTrue(ScoopStatus(state: "working", fill: 75).isNearLimit)
        XCTAssertTrue(ScoopStatus(state: "working", fill: 100).isNearLimit)
    }

    func testAccessibilityPhraseWithStateAndFill() {
        let status = ScoopStatus(state: "broken", fill: 82)

        XCTAssertEqual(
            status.accessibilityPhrase(label: "Reviewer"),
            "Reviewer: broken, 82% context fill")
    }

    func testAccessibilityPhraseWithUnknownState() {
        let status = ScoopStatus(state: nil, fill: 64)

        XCTAssertEqual(
            status.accessibilityPhrase(label: "Reviewer"),
            "Reviewer: unknown, 64% context fill")
    }

    func testAccessibilityPhraseWithUnknownFill() {
        let status = ScoopStatus(state: "working", fill: nil)

        XCTAssertEqual(
            status.accessibilityPhrase(label: "Reviewer"),
            "Reviewer: working, context fill unknown")
    }

    func testAccessibilityPhraseWithUnknownStateAndFill() {
        let status = ScoopStatus(state: nil, fill: nil)

        XCTAssertEqual(
            status.accessibilityPhrase(label: "Reviewer"),
            "Reviewer: unknown, context fill unknown")
    }

    func testScoopSummaryBuildsStatusPresentationValue() {
        let summary = ScoopSummary(
            jid: "reviewer", name: "reviewer", folder: "/scoops/reviewer", isCone: false,
            assistantLabel: "Reviewer", trigger: nil, state: "broken", fill: 82)

        XCTAssertEqual(summary.status, ScoopStatus(state: "broken", fill: 82))
    }
}
