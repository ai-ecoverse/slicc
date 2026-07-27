import XCTest
import Foundation
@testable import SliccFollower

/// Transport-level chunk framing (#1700).
///
/// A message over the SCTP per-message limit was previously handed straight to
/// the data channel, which rejects it — so an oversize `agent_event` (a
/// screenshot from `open --view --size high`, a large untruncated tool result)
/// never reached the follower at all. Framing sits below the message union, so
/// every leader→follower type gains oversize support at once.
final class TrayChunkFramingTests: XCTestCase {

    private func encode(_ frame: TrayChunkFrame) throws -> Data {
        try JSONEncoder().encode(frame)
    }

    // MARK: - Framing

    func testFramesStayWithinTransportLimit() throws {
        // CJK: 3 UTF-8 bytes per character. Sizing that counts characters
        // rather than bytes under-counts these 3x and produces frames the
        // transport rejects.
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
        // A frame cut mid-character corrupts both halves.
        let text = String(repeating: "🍦", count: 20_000)

        let rebuilt = TrayChunkFraming.frameChunks(text).map(\.chunkData).joined()

        XCTAssertEqual(rebuilt, text)
        XCTAssertEqual(rebuilt.count, 20_000)
    }

    func testFramesAreNumberedConsistently() {
        let frames = TrayChunkFraming.frameChunks(String(repeating: "y", count: 200_000),
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

    // MARK: - Reassembly

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

        // `__chunk` is reserved transport vocabulary: a frame with impossible
        // indices is rejected, never treated as a message.
        let outcome = reassembler.accept(TrayChunkFrame(type: TrayChunkFrame.typeTag,
                                                        chunkId: "bad",
                                                        chunkIndex: 5,
                                                        totalChunks: 2,
                                                        chunkData: "x"))

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

        // The oldest was evicted, so completing it yields nothing.
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
