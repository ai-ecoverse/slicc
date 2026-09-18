import Foundation
import XCTest

@testable import SliccTrayFollower




final class TrayChunkReassemblerTests: XCTestCase {

    private func frame(_ chunkId: String, index: Int, total: Int, data: String) -> TrayChunkFrame {
        TrayChunkFrame(type: TrayChunkFrame.typeTag, chunkId: chunkId, chunkIndex: index, totalChunks: total, chunkData: data)
    }

    func testIsEmptyReflectsInFlightBuffers() {
        var reassembler = TrayChunkReassembler()
        XCTAssertTrue(reassembler.isEmpty)

        let pending = reassembler.accept(frame("c1", index: 0, total: 2, data: "a"))
        XCTAssertNil(pending.message)
        XCTAssertNil(pending.rejection)
        XCTAssertFalse(reassembler.isEmpty)

        let done = reassembler.accept(frame("c1", index: 1, total: 2, data: "b"))
        XCTAssertEqual(done.message.map { String(decoding: $0, as: UTF8.self) }, "ab")
        XCTAssertTrue(reassembler.isEmpty)
    }

    func testOutOfOrderFramesStillComplete() {
        var reassembler = TrayChunkReassembler()
        XCTAssertNil(reassembler.accept(frame("c1", index: 2, total: 3, data: "C")).message)
        XCTAssertNil(reassembler.accept(frame("c1", index: 0, total: 3, data: "A")).message)
        let done = reassembler.accept(frame("c1", index: 1, total: 3, data: "B"))
        XCTAssertEqual(done.message.map { String(decoding: $0, as: UTF8.self) }, "ABC")
    }

    func testDuplicateFrameIsIgnored() {
        var reassembler = TrayChunkReassembler()
        XCTAssertNil(reassembler.accept(frame("c1", index: 0, total: 2, data: "a")).message)
        
        let duplicate = reassembler.accept(frame("c1", index: 0, total: 2, data: "a"))
        XCTAssertNil(duplicate.message)
        XCTAssertNil(duplicate.rejection)
        XCTAssertFalse(reassembler.isEmpty)
    }

    func testTotalChunksMismatchIsRejected() {
        var reassembler = TrayChunkReassembler()
        XCTAssertNil(reassembler.accept(frame("c1", index: 0, total: 3, data: "a")).message)
        
        let outcome = reassembler.accept(frame("c1", index: 1, total: 4, data: "b"))
        XCTAssertEqual(outcome.rejection, .malformed)
    }

    func testTotalChunksAboveHardCapIsRejected() {
        var reassembler = TrayChunkReassembler()
        let outcome = reassembler.accept(frame("c1", index: 0, total: 9_000, data: "a"))
        XCTAssertEqual(outcome.rejection, .malformed)
    }

    func testOversizeReassemblyIsRejected() {
        var reassembler = TrayChunkReassembler()
        
        let huge = String(repeating: "x", count: TrayChunkLimits.maxTotalBytes + 1)
        let outcome = reassembler.accept(frame("c1", index: 0, total: 1, data: huge))
        XCTAssertEqual(outcome.rejection, .oversize)
        XCTAssertTrue(reassembler.isEmpty)
    }

    func testRemoveAllDropsInFlightBuffers() {
        var reassembler = TrayChunkReassembler()
        XCTAssertNil(reassembler.accept(frame("c1", index: 0, total: 2, data: "a")).message)
        XCTAssertFalse(reassembler.isEmpty)
        reassembler.removeAll()
        XCTAssertTrue(reassembler.isEmpty)
    }

    func testOldestBufferIsEvictedBeyondPendingBound() {
        var reassembler = TrayChunkReassembler()
        
        
        let openCount = TrayChunkLimits.maxPending + 2
        for i in 0..<openCount {
            XCTAssertNil(reassembler.accept(frame("c\(i)", index: 0, total: 2, data: "a")).message)
        }
        
        
        let outcome = reassembler.accept(frame("c0", index: 1, total: 2, data: "b"))
        XCTAssertNil(outcome.message)
        XCTAssertNil(outcome.rejection)
    }

    func testFramingAnEmptyStringYieldsOneRecoverableFrame() {
        let frames = TrayChunkFraming.frameChunks("", chunkId: "empty")
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].chunkData, "")

        var reassembler = TrayChunkReassembler()
        let outcome = reassembler.accept(frames[0])
        XCTAssertEqual(outcome.message, Data())
    }
}
