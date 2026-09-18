import Foundation
import SliccTrayKit
import UIKit
import XCTest

@testable import SliccFollower

@MainActor
final class AppStateComputersTests: XCTestCase {
    private func send(_ message: LeaderToFollowerMessage, to state: AppState) throws {
        state.handleDataChannelMessage(try JSONEncoder().encode(message))
    }

    private func descriptor(
        id: String = "jsh:clock", title: String = "Clock",
        softKeys: [ComputerSoftKey]? = [ComputerSoftKey(label: "Home", keysym: "Home")]
    ) -> ComputerDescriptor {
        ComputerDescriptor(
            id: id, kind: "jsh", title: title,
            size: ComputerSize(width: 640, height: 400), state: "live",
            capabilities: ComputerCapabilities(
                screenshot: true, text: false, frames: "poll", keyboard: true,
                mouse: "absolute", scroll: true, exec: false, inputAllowed: true),
            pid: nil, softKeys: softKeys)
    }

    private func jpegBase64() -> String {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let data = image.jpegData(compressionQuality: 0.8)!
        return data.base64EncodedString()
    }

    func testHelloDoesNotAdvertiseComputerCapture() {
        let caps = AppState().followerCapabilities()
        XCTAssertNil(caps.computer)
        XCTAssertTrue(caps.exec)
    }

    func testComputersListPaintsRosterAndDropsStaleFrames() throws {
        let state = AppState()
        try send(
            .computersList(computers: [descriptor(), descriptor(id: "ssh:desk", title: "Desk")]),
            to: state)
        XCTAssertEqual(state.computers.map(\.id), ["jsh:clock", "ssh:desk"])
        _ = state.liveFrame(forComputerId: "jsh:clock")
        try send(.computersList(computers: [descriptor(id: "ssh:desk", title: "Desk")]), to: state)
        XCTAssertEqual(state.computers.map(\.id), ["ssh:desk"])
        XCTAssertNil(state.computerRosterStorage.liveFrames["jsh:clock"])
    }

    func testComputerFrameDecodesJpegOntoTheLiveObject() throws {
        let state = AppState()
        try send(.computersList(computers: [descriptor()]), to: state)
        let b64 = jpegBase64()
        try send(
            .computerFrame(
                id: "jsh:clock", seq: 3, mime: "image/jpeg", width: 8, height: 8, data: b64,
                chunkData: nil, chunkIndex: nil, totalChunks: nil), to: state)
        let frame = state.liveFrame(forComputerId: "jsh:clock")
        XCTAssertEqual(frame.seq, 3)
        XCTAssertNotNil(frame.image)
        XCTAssertEqual(frame.pixelSize, CGSize(width: 8, height: 8))
    }

    func testChunkedComputerFrameReassemblesBeforeDecode() throws {
        let state = AppState()
        try send(.computersList(computers: [descriptor()]), to: state)
        let b64 = jpegBase64()
        let mid = b64.index(b64.startIndex, offsetBy: b64.count / 2)
        try send(
            .computerFrame(
                id: "jsh:clock", seq: 1, mime: "image/jpeg", width: 8, height: 8, data: nil,
                chunkData: String(b64[mid...]), chunkIndex: 1, totalChunks: 2), to: state)
        XCTAssertNil(state.liveFrame(forComputerId: "jsh:clock").image)
        try send(
            .computerFrame(
                id: "jsh:clock", seq: 1, mime: "image/jpeg", width: 8, height: 8, data: nil,
                chunkData: String(b64[..<mid]), chunkIndex: 0, totalChunks: 2), to: state)
        XCTAssertNotNil(state.liveFrame(forComputerId: "jsh:clock").image)
        XCTAssertEqual(state.liveFrame(forComputerId: "jsh:clock").seq, 1)
    }

    func testWatchIsRefcountedAndUnwatchOnRosterDrop() throws {
        let state = AppState()
        try send(.computersList(computers: [descriptor()]), to: state)
        state.startWatchingComputer("jsh:clock")
        state.startWatchingComputer("jsh:clock")
        XCTAssertEqual(
            state.debugComputerOutgoing.filter {
                if case .computerWatch = $0 { return true }
                return false
            }.count, 1)
        state.stopWatchingComputer("jsh:clock")
        XCTAssertFalse(
            state.debugComputerOutgoing.contains {
                if case .computerUnwatch = $0 { return true }
                return false
            })
        state.stopWatchingComputer("jsh:clock")
        XCTAssertTrue(
            state.debugComputerOutgoing.contains {
                if case .computerUnwatch(let id) = $0 { return id == "jsh:clock" }
                return false
            })
        state.startWatchingComputer("jsh:clock")
        try send(.computersList(computers: []), to: state)
        XCTAssertTrue(
            state.debugComputerOutgoing.contains {
                if case .computerUnwatch(let id) = $0 { return id == "jsh:clock" }
                return false
            })
        XCTAssertTrue(state.computers.isEmpty)
    }

    func testReconnectReplaysRefcountedWatchesForCardsAndViewer() throws {
        let state = AppState()
        state.autoReconnect = false
        state.connectionState = .connected
        try send(
            .computersList(computers: [
                descriptor(), descriptor(id: "ssh:desk", title: "Desk"),
            ]), to: state)
        
        
        state.startWatchingComputer("jsh:clock")
        state.startWatchingComputer("jsh:clock")
        state.startWatchingComputer("ssh:desk")
        state.viewingComputerId = "jsh:clock"
        let initialWatches = state.debugComputerOutgoing.compactMap { message -> String? in
            if case .computerWatch(let id, _, _) = message { return id }
            return nil
        }
        XCTAssertEqual(Set(initialWatches), ["jsh:clock", "ssh:desk"])
        XCTAssertEqual(initialWatches.count, 2)

        state.debugComputerOutgoing.removeAll()
        state.handleDisconnect(reason: "transient")
        XCTAssertEqual(state.computerRosterStorage.watchCounts["jsh:clock"], 2)
        XCTAssertEqual(state.computerRosterStorage.watchCounts["ssh:desk"], 1)
        XCTAssertEqual(state.computers.map(\.id), ["jsh:clock", "ssh:desk"])

        try send(
            .computersList(computers: [
                descriptor(), descriptor(id: "ssh:desk", title: "Desk"),
            ]), to: state)
        let replayed = state.debugComputerOutgoing.compactMap { message -> String? in
            if case .computerWatch(let id, _, _) = message { return id }
            return nil
        }
        XCTAssertEqual(Set(replayed), ["jsh:clock", "ssh:desk"])
        XCTAssertEqual(replayed.count, 2)
    }

    func testSoftKeySendsComputerInput() {
        let state = AppState()
        state.sendComputerSoftKey(id: "jsh:clock", keysym: "Home")
        guard case .computerInput(let id, let events) = state.debugComputerOutgoing.last else {
            return XCTFail("expected computer.input")
        }
        XCTAssertEqual(id, "jsh:clock")
        XCTAssertEqual(events, [.key(keysym: "Home", down: nil)])
    }

    func testNativeCaptureMessagesAreIgnored() throws {
        let state = AppState()
        try send(.computersList(computers: [descriptor()]), to: state)
        try send(
            .computerNativeCapture(requestId: "n1", fps: 2, maxWidth: 480, watch: true), to: state)
        XCTAssertEqual(state.computers.count, 1)
        XCTAssertNil(state.liveFrame(forComputerId: "jsh:clock").image)
    }

    func testDisconnectClearsComputerRoster() throws {
        let state = AppState()
        try send(.computersList(computers: [descriptor()]), to: state)
        state.viewingComputerId = "jsh:clock"
        _ = state.liveFrame(forComputerId: "jsh:clock")
        state.resetComputers()
        XCTAssertTrue(state.computers.isEmpty)
        XCTAssertNil(state.viewingComputerId)
        XCTAssertTrue(state.computerRosterStorage.liveFrames.isEmpty)
    }
}

final class ComputerFrameAssemblerTests: XCTestCase {
    func testOneShotDataReturnsImmediately() {
        var assembler = ComputerFrameAssembler()
        XCTAssertEqual(
            assembler.accept(
                id: "a", seq: 1, data: "abc", chunkData: nil, chunkIndex: nil, totalChunks: nil),
            "abc")
        XCTAssertEqual(assembler.pendingCount, 0)
    }

    func testChunksJoinInIndexOrder() {
        var assembler = ComputerFrameAssembler()
        XCTAssertNil(
            assembler.accept(
                id: "a", seq: 1, data: nil, chunkData: "YY", chunkIndex: 1, totalChunks: 2))
        XCTAssertEqual(
            assembler.accept(
                id: "a", seq: 1, data: nil, chunkData: "XX", chunkIndex: 0, totalChunks: 2),
            "XXYY")
        XCTAssertEqual(assembler.pendingCount, 0)
    }

    func testMalformedChunkCountIsRejectedWithoutAllocating() {
        var assembler = ComputerFrameAssembler(maxChunkCount: 4, maxPending: 2, maxReassemblyBytes: 64)
        XCTAssertNil(
            assembler.accept(
                id: "a", seq: 1, data: nil, chunkData: "x", chunkIndex: 0, totalChunks: 100_000))
        XCTAssertNil(
            assembler.accept(
                id: "a", seq: 1, data: nil, chunkData: "x", chunkIndex: 0, totalChunks: 0))
        XCTAssertNil(
            assembler.accept(
                id: "a", seq: 1, data: nil, chunkData: "x", chunkIndex: 4, totalChunks: 4))
        XCTAssertEqual(assembler.pendingCount, 0)
    }

    func testPartialStreamsAreEvictedWhenPendingOverflows() {
        var assembler = ComputerFrameAssembler(maxChunkCount: 4, maxPending: 2, maxReassemblyBytes: 64)
        XCTAssertNil(
            assembler.accept(
                id: "a", seq: 1, data: nil, chunkData: "A0", chunkIndex: 0, totalChunks: 2))
        XCTAssertNil(
            assembler.accept(
                id: "b", seq: 1, data: nil, chunkData: "B0", chunkIndex: 0, totalChunks: 2))
        XCTAssertEqual(assembler.pendingCount, 2)
        XCTAssertNil(
            assembler.accept(
                id: "c", seq: 1, data: nil, chunkData: "C0", chunkIndex: 0, totalChunks: 2))
        XCTAssertEqual(assembler.pendingCount, 2)
        XCTAssertNil(
            assembler.accept(
                id: "a", seq: 1, data: nil, chunkData: "A1", chunkIndex: 1, totalChunks: 2),
            "stale incomplete frame a must not complete after eviction")
    }

    func testOversizedChunkIsRejected() {
        var assembler = ComputerFrameAssembler(maxChunkCount: 4, maxPending: 2, maxReassemblyBytes: 4)
        XCTAssertNil(
            assembler.accept(
                id: "a", seq: 1, data: nil, chunkData: "too-big", chunkIndex: 0, totalChunks: 2))
        XCTAssertEqual(assembler.pendingCount, 0)
    }
}
