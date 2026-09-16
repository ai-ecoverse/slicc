import SliccTrayKit
import XCTest

@testable import SliccFollower

final class ToolProgressChromeTests: XCTestCase {
    private func unit(
        fraction: Double? = nil, etaMs: Double? = nil, done: Double? = nil,
        total: Double? = nil, measure: String? = nil
    ) -> ToolProgressEvent {
        ToolProgressEvent(
            id: "u1", label: "sleep 30", fraction: fraction, etaMs: etaMs, done: done,
            total: total, unit: measure, phase: .update)
    }

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

    func testCaptionCombinesCountPercentAndEta() {
        XCTAssertEqual(
            toolProgressCaption(
                unit(fraction: 0.25, etaMs: 21_000, done: 3, total: 12, measure: "iterations")),
            "3/12 · 25% · ~21s")
    }

    func testCaptionFallsBackToBytesWhenIndeterminate() {
        XCTAssertEqual(
            toolProgressCaption(unit(done: 45_678_901, measure: "bytes")), "46 MB")
    }

    func testCaptionIsEmptyForABareIndeterminateUnit() {
        XCTAssertEqual(toolProgressCaption(unit()), "")
    }

    func testEtaKeepsTheRemainderLikeTheWebFormatter() {
        XCTAssertEqual(formatProgressEta(8_000), "8s")
        XCTAssertEqual(formatProgressEta(400), "0s")
        XCTAssertEqual(formatProgressEta(119_000), "1m59s")
        XCTAssertEqual(formatProgressEta(150_000), "2m30s")
        XCTAssertEqual(formatProgressEta(3_600_000), "1h00m")
        XCTAssertEqual(formatProgressEta(7_140_000), "1h59m")
    }

    func testBytesFormatMatchesTheWebScale() {
        XCTAssertEqual(formatProgressBytes(512), "512 B")
        XCTAssertEqual(formatProgressBytes(2_048), "2.0 kB")
        XCTAssertEqual(formatProgressBytes(20_480), "20 kB")
        XCTAssertEqual(formatProgressBytes(5_678_901), "5.7 MB")
        XCTAssertEqual(formatProgressBytes(45_678_901), "46 MB")
        XCTAssertEqual(formatProgressBytes(-1), "")
    }

    private func call(_ id: String, result: String? = nil) -> ToolCall {
        ToolCall(id: id, name: "bash", input: nil, result: result)
    }

    func testClusterAggregateCountsFinishedCallsAndPartials() throws {
        let calls = [call("a", result: "ok"), call("b"), call("c")]
        let aggregate = try XCTUnwrap(
            aggregateToolProgress(calls: calls, progress: ["b": unit(fraction: 0.5)]))

        XCTAssertEqual(try XCTUnwrap(aggregate.fraction), 0.5, accuracy: 0.0001)
        XCTAssertEqual(aggregate.done, 1)
        XCTAssertEqual(aggregate.total, 3)
        XCTAssertEqual(aggregate.label, "1 of 3 done")
    }

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

    func testClusterAggregateNeverExceedsOne() throws {
        let calls = [call("a", result: "ok"), call("b")]
        let aggregate = try XCTUnwrap(
            aggregateToolProgress(calls: calls, progress: ["b": unit(fraction: 1)]))
        XCTAssertEqual(try XCTUnwrap(aggregate.fraction), 1, accuracy: 0.0001)
    }

    func testChatFixtureStagesProgressOnRealRows() {
        let rows = Set(
            ChatFixture.makeMessages().flatMap { $0.toolCalls ?? [] }.map(\.id))
        XCTAssertFalse(ChatFixture.toolProgress.isEmpty)
        for rowId in ChatFixture.toolProgress.keys {
            XCTAssertTrue(rows.contains(rowId), "fixture unit \(rowId) has no row")
        }
    }
}
