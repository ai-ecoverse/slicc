import SliccTrayKit
import XCTest

@testable import SliccFollower

final class ScoopStatusTests: XCTestCase {
    func testLifecycleMapsEveryWireValueAndUnknowns() {
        XCTAssertEqual(ScoopLifecycle(state: "working"), .working)
        XCTAssertEqual(ScoopLifecycle(state: "broken"), .broken)
        XCTAssertEqual(ScoopLifecycle(state: "initializing"), .initializing)
        XCTAssertEqual(ScoopLifecycle(state: "idle"), .idle)
        // Absent (a leader older than the lifecycle fields) and unrecognised (a
        // leader newer than this build) both degrade to the same quiet floor.
        XCTAssertEqual(ScoopLifecycle(state: nil), .unknown)
        XCTAssertEqual(ScoopLifecycle(state: "future-state"), .unknown)
    }

    func testLifecycleVocabularyStaysClosed() {
        // The compatibility invariant, pinned: `state` carries these four
        // values and nothing else. A refinement that leaked in here would reach
        // older followers — which do NOT normalize what they cannot parse — and
        // silently cost a busy agent its treatment. Detail belongs in
        // `ScoopActivity`, which those builds never read.
        XCTAssertEqual(
            Set(ScoopLifecycle.allCases.map(\.rawValue)),
            ["working", "broken", "initializing", "idle", "unknown"])
    }

    func testActivityRefinementParsesAndIgnoresTheUnknown() {
        XCTAssertEqual(ScoopActivity(activity: "thinking"), .thinking)
        XCTAssertEqual(ScoopActivity(activity: "tool"), .tool)
        XCTAssertEqual(ScoopActivity(activity: "awaiting"), .awaiting)
        // The escape hatch: absent (older leader) and unrecognised (newer
        // leader) both fall back to the lifecycle alone.
        XCTAssertNil(ScoopActivity(activity: nil))
        XCTAssertNil(ScoopActivity(activity: "daydreaming"))
        for activity in ScoopActivity.allCases {
            XCTAssertEqual(ScoopActivity(activity: activity.rawValue), activity)
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
