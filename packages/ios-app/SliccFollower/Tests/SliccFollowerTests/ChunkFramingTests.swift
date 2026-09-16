import Foundation
import XCTest

@testable import SliccFollower
@testable import SliccTrayFollower
@testable import SliccTrayKit

final class TrayChunkFramingTests: XCTestCase {

    private func encode(_ frame: TrayChunkFrame) throws -> Data {
        try JSONEncoder().encode(frame)
    }

    func testFramesStayWithinTransportLimit() throws {

        let payload = #"{"text":"\#(String(repeating: "漢", count: 120_000))"}"#

        let frames = TrayChunkFraming.frameChunks(payload)

        XCTAssertGreaterThan(frames.count, 1)
        for frame in frames {
            let encoded = try encode(frame)
            XCTAssertLessThanOrEqual(
                encoded.count,
                TrayChunkLimits.maxMessageBytes,
                "frame \(frame.chunkIndex) is \(encoded.count) bytes"
            )
        }
    }

    func testFramesRoundTripExactly() {
        let text = #"{"mixed":"a\"\\b\#(String(repeating: "漢", count: 50_000))🍦"}"#

        let rebuilt = TrayChunkFraming.frameChunks(text).map(\.chunkData).joined()

        XCTAssertEqual(rebuilt, text)
    }

    func testFramesSplitOnCharacterBoundaries() {

        let text = String(repeating: "🍦", count: 20_000)

        let rebuilt = TrayChunkFraming.frameChunks(text).map(\.chunkData).joined()

        XCTAssertEqual(rebuilt, text)
        XCTAssertEqual(rebuilt.count, 20_000)
    }

    func testOversizedGraphemeClusterDoesNotBlowTheFrameBudget() throws {

        let monster = "a" + String(repeating: "\u{0301}", count: 60_000)
        XCTAssertEqual(monster.count, 1, "precondition: a single Character")

        let frames = TrayChunkFraming.frameChunks(monster)

        XCTAssertGreaterThan(frames.count, 1)
        for frame in frames {
            let encoded = try encode(frame)
            XCTAssertLessThanOrEqual(
                encoded.count, TrayChunkLimits.maxMessageBytes,
                "frame \(frame.chunkIndex) is \(encoded.count) bytes")
        }
        XCTAssertEqual(frames.map(\.chunkData).joined(), monster)
    }

    func testFramesAreNumberedConsistently() {
        let frames = TrayChunkFraming.frameChunks(
            String(repeating: "y", count: 200_000),
            chunkId: "shared-id")

        for (index, frame) in frames.enumerated() {
            XCTAssertEqual(frame.type, TrayChunkFrame.typeTag)
            XCTAssertEqual(frame.chunkId, "shared-id")
            XCTAssertEqual(frame.chunkIndex, index)
            XCTAssertEqual(frame.totalChunks, frames.count)
        }
    }

    func testEmptyPayloadYieldsOneFrame() {
        XCTAssertEqual(TrayChunkFraming.frameChunks("").count, 1)
    }

    func testReassemblesChunkedMessage() {
        var reassembler = TrayChunkReassembler()
        let original = #"{"type":"status","scoopStatus":"\#(String(repeating: "x", count: 200_000))"}"#
        let frames = TrayChunkFraming.frameChunks(original, chunkId: "m1")

        var completed: Data?
        for frame in frames {
            completed = reassembler.accept(frame).message ?? completed
        }

        XCTAssertEqual(completed.flatMap { String(bytes: $0, encoding: .utf8) }, original)
        XCTAssertTrue(reassembler.isEmpty)
    }

    func testReassemblesOutOfOrderFrames() {
        var reassembler = TrayChunkReassembler()
        let original = #"{"type":"status","scoopStatus":"\#(String(repeating: "x", count: 200_000))"}"#

        var completed: Data?
        for frame in TrayChunkFraming.frameChunks(original, chunkId: "ooo").reversed() {
            completed = reassembler.accept(frame).message ?? completed
        }

        XCTAssertEqual(completed.flatMap { String(bytes: $0, encoding: .utf8) }, original)
    }

    func testIgnoresDuplicateFrames() {
        var reassembler = TrayChunkReassembler()
        let original = #"{"type":"status","scoopStatus":"\#(String(repeating: "x", count: 200_000))"}"#

        var completions = 0
        for frame in TrayChunkFraming.frameChunks(original, chunkId: "dup") {
            if reassembler.accept(frame).message != nil { completions += 1 }
            if reassembler.accept(frame).message != nil { completions += 1 }
        }

        XCTAssertEqual(completions, 1)
    }

    func testWaitsForEveryFrame() {
        var reassembler = TrayChunkReassembler()
        let original = #"{"type":"status","scoopStatus":"\#(String(repeating: "x", count: 200_000))"}"#
        let frames = TrayChunkFraming.frameChunks(original, chunkId: "partial")

        for frame in frames.dropLast() {
            XCTAssertNil(reassembler.accept(frame).message)
        }
        XCTAssertFalse(reassembler.isEmpty)
    }

    func testKeepsConcurrentReassembliesSeparate() {
        var reassembler = TrayChunkReassembler()
        let first = #"{"type":"status","scoopStatus":"\#(String(repeating: "a", count: 200_000))"}"#
        let second = #"{"type":"status","scoopStatus":"\#(String(repeating: "b", count: 180_000))"}"#
        let a = TrayChunkFraming.frameChunks(first, chunkId: "A")
        let b = TrayChunkFraming.frameChunks(second, chunkId: "B")

        var completed: [String] = []
        for index in 0..<max(a.count, b.count) {
            if index < a.count, let done = reassembler.accept(a[index]).message {
                if let text = String(bytes: done, encoding: .utf8) { completed.append(text) }
            }
            if index < b.count, let done = reassembler.accept(b[index]).message {
                if let text = String(bytes: done, encoding: .utf8) { completed.append(text) }
            }
        }

        XCTAssertEqual(Set(completed), Set([first, second]))
    }

    func testRejectsMalformedFrame() {
        var reassembler = TrayChunkReassembler()

        let outcome = reassembler.accept(
            TrayChunkFrame(
                type: TrayChunkFrame.typeTag,
                chunkId: "bad",
                chunkIndex: 5,
                totalChunks: 2,
                chunkData: "x"))

        XCTAssertNil(outcome.message)
        XCTAssertEqual(outcome.rejection, .malformed)
        XCTAssertTrue(reassembler.isEmpty)
    }

    func testRejectsInconsistentTotalChunks() {
        var reassembler = TrayChunkReassembler()

        _ = reassembler.accept(
            TrayChunkFrame(
                type: TrayChunkFrame.typeTag, chunkId: "x",
                chunkIndex: 0, totalChunks: 2, chunkData: "a"))
        let outcome = reassembler.accept(
            TrayChunkFrame(
                type: TrayChunkFrame.typeTag, chunkId: "x",
                chunkIndex: 99, totalChunks: 100,
                chunkData: "b"))

        XCTAssertNil(outcome.message)
        XCTAssertEqual(outcome.rejection, .malformed)
    }

    func testRejectsExcessiveChunkCount() {
        var reassembler = TrayChunkReassembler()

        let outcome = reassembler.accept(
            TrayChunkFrame(
                type: TrayChunkFrame.typeTag,
                chunkId: "huge", chunkIndex: 0,
                totalChunks: 1_000_000_000,
                chunkData: "a"))

        XCTAssertNil(outcome.message)
        XCTAssertEqual(outcome.rejection, .malformed)
        XCTAssertTrue(reassembler.isEmpty)
    }

    func testEvictsOldestIncompleteReassembly() {
        var reassembler = TrayChunkReassembler()
        let original = #"{"type":"status","scoopStatus":"\#(String(repeating: "x", count: 200_000))"}"#

        var started: [[TrayChunkFrame]] = []
        for index in 0..<(TrayChunkLimits.maxPending + 2) {
            let frames = TrayChunkFraming.frameChunks(original, chunkId: "id-\(index)")
            started.append(frames)
            _ = reassembler.accept(frames[0])
        }

        var completed: Data?
        for frame in started[0].dropFirst() {
            completed = reassembler.accept(frame).message ?? completed
        }

        XCTAssertNil(completed)
    }

    func testRemoveAllClearsInFlightState() {
        var reassembler = TrayChunkReassembler()
        let original = #"{"type":"status","scoopStatus":"\#(String(repeating: "x", count: 200_000))"}"#
        let frames = TrayChunkFraming.frameChunks(original, chunkId: "closing")
        _ = reassembler.accept(frames[0])

        reassembler.removeAll()

        XCTAssertTrue(reassembler.isEmpty)
    }
}
