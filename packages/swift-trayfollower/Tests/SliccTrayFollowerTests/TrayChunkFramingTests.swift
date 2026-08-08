import Foundation
import XCTest

@testable import SliccTrayFollower

/// Transport chunk framing + reassembly (the layer below the message unions).
final class TrayChunkFramingTests: XCTestCase {

    func testFrameChunksRoundTripsThroughReassembler() throws {
        // A message larger than one chunk splits, and the reassembler recovers
        // the exact original once every frame has arrived.
        let message = String(repeating: "SLICC-ünïcode-🍦-", count: 5_000)
        let frames = TrayChunkFraming.frameChunks(message, chunkId: "c1")
        XCTAssertGreaterThan(frames.count, 1)

        var reassembler = TrayChunkReassembler()
        var recovered: Data?
        for frame in frames {
            let outcome = reassembler.accept(frame)
            if let data = outcome.message { recovered = data }
        }
        XCTAssertEqual(recovered.map { String(decoding: $0, as: UTF8.self) }, message)
    }

    func testFrameChunksStayWithinTheSctpSafeCeiling() {
        let frames = TrayChunkFraming.frameChunks(String(repeating: "x", count: 500_000))
        for frame in frames {
            let serialized = try? JSONEncoder().encode(frame)
            XCTAssertNotNil(serialized)
            XCTAssertLessThanOrEqual(serialized!.count, TrayChunkLimits.maxMessageBytes)
        }
    }

    func testReassemblerRejectsMalformedIndices() {
        var reassembler = TrayChunkReassembler()
        let bad = TrayChunkFrame(
            type: TrayChunkFrame.typeTag, chunkId: "x", chunkIndex: 5, totalChunks: 2,
            chunkData: "oops")
        XCTAssertEqual(reassembler.accept(bad).rejection, .malformed)
    }
}
