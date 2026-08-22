import SliccTrayKit
import XCTest

@testable import SliccFollower

/// The pure half of the bash-progress treatment: the numbers the row chrome
/// reads. Ports the webapp's `aggregateClusterProgress` / `progressTitle`
/// expectations (`packages/webapp/src/ui/wc/wc-message-view.ts`) so the two
/// followers agree on what a tick means before either paints it.
final class ToolProgressChromeTests: XCTestCase {
    private func unit(
        fraction: Double? = nil, etaMs: Double? = nil, done: Double? = nil,
        total: Double? = nil, measure: String? = nil
    ) -> ToolProgressEvent {
        ToolProgressEvent(
            id: "u1", label: "sleep 30", fraction: fraction, etaMs: etaMs, done: done,
            total: total, unit: measure, phase: .update)
    }

    // MARK: - Fraction

    func testFractionClampsToUnitRange() {
        XCTAssertEqual(toolProgressFraction(unit(fraction: 1.4)), 1)
        XCTAssertEqual(toolProgressFraction(unit(fraction: -0.2)), 0)
        XCTAssertEqual(toolProgressFraction(unit(fraction: 0.43)), 0.43)
    }

    func testFractionIsNilWhenIndeterminateOrNotFinite() {
        XCTAssertNil(toolProgressFraction(nil))
        XCTAssertNil(toolProgressFraction(unit()))
        XCTAssertNil(toolProgressFraction(unit(fraction: .nan)))
        XCTAssertNil(toolProgressFraction(unit(fraction: .infinity)))
    }

    // MARK: - Caption

    func testCaptionCombinesCountPercentAndEta() {
        XCTAssertEqual(
            toolProgressCaption(
                unit(fraction: 0.25, etaMs: 21_000, done: 3, total: 12, measure: "iterations")),
            "3/12 · 25% · ~21s")
    }

    /// An indeterminate byte unit has no percentage to show, so the transferred
    /// count stands in for it.
    func testCaptionFallsBackToBytesWhenIndeterminate() {
        XCTAssertEqual(
            toolProgressCaption(unit(done: 45_678_901, measure: "bytes")), "44 MB")
    }

    func testCaptionIsEmptyForABareIndeterminateUnit() {
        XCTAssertEqual(toolProgressCaption(unit()), "")
    }

    func testEtaFormatsBySize() {
        XCTAssertEqual(formatProgressEta(8_000), "8s")
        XCTAssertEqual(formatProgressEta(400), "1s")
        XCTAssertEqual(formatProgressEta(150_000), "2m")
        XCTAssertEqual(formatProgressEta(7_200_000), "2h")
    }

    func testBytesFormatMatchesTheWebScale() {
        XCTAssertEqual(formatProgressBytes(512), "512 B")
        XCTAssertEqual(formatProgressBytes(2_048), "2.0 KB")
        XCTAssertEqual(formatProgressBytes(20_480), "20 KB")
    }

    // MARK: - Cluster aggregate

    private func call(_ id: String, result: String? = nil) -> ToolCall {
        ToolCall(id: id, name: "bash", input: nil, result: result)
    }

    func testClusterAggregateCountsFinishedCallsAndPartials() throws {
        let calls = [call("a", result: "ok"), call("b"), call("c")]
        let aggregate = try XCTUnwrap(
            aggregateToolProgress(calls: calls, progress: ["b": unit(fraction: 0.5)]))

        // 1 done + a half-finished second call, out of three.
        XCTAssertEqual(try XCTUnwrap(aggregate.fraction), 0.5, accuracy: 0.0001)
        XCTAssertEqual(aggregate.done, 1)
        XCTAssertEqual(aggregate.total, 3)
        XCTAssertEqual(aggregate.label, "1 of 3 done")
    }

    /// The batch size is known before any call finishes, so the head is always
    /// determinate — an indeterminate member just contributes nothing.
    func testClusterAggregateStaysDeterminateWithIndeterminateMembers() throws {
        let calls = [call("a", result: "ok"), call("b")]
        let aggregate = try XCTUnwrap(
            aggregateToolProgress(calls: calls, progress: ["b": unit()]))
        XCTAssertEqual(try XCTUnwrap(aggregate.fraction), 0.5, accuracy: 0.0001)
    }

    func testClusterAggregateIsNilWhenNothingIsRunning() {
        XCTAssertNil(
            aggregateToolProgress(
                calls: [call("a", result: "ok"), call("b", result: "ok")], progress: [:]))
        XCTAssertNil(aggregateToolProgress(calls: [], progress: [:]))
    }

    /// A finished batch never reports over 100%, however the partials add up.
    func testClusterAggregateNeverExceedsOne() throws {
        let calls = [call("a", result: "ok"), call("b")]
        let aggregate = try XCTUnwrap(
            aggregateToolProgress(calls: calls, progress: ["b": unit(fraction: 1)]))
        XCTAssertEqual(try XCTUnwrap(aggregate.fraction), 1, accuracy: 0.0001)
    }

    // MARK: - Fixture

    /// The fixture route is how a reviewer sees the treatment without a leader,
    /// so its units must actually resolve against the fixture's rows.
    func testChatFixtureStagesProgressOnRealRows() {
        let rows = Set(
            ChatFixture.makeMessages().flatMap { $0.toolCalls ?? [] }.map(\.id))
        XCTAssertFalse(ChatFixture.toolProgress.isEmpty)
        for rowId in ChatFixture.toolProgress.keys {
            XCTAssertTrue(rows.contains(rowId), "fixture unit \(rowId) has no row")
        }
    }
}
