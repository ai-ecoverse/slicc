import XCTest

@testable import SliccFollower
@testable import SliccTrayKit
@testable import SliccTrayVFS

/// Covers the two properties `FsClient` owns that the leader does not: a
/// deadline on every request, and all-or-nothing chunk reassembly.
@MainActor
final class FsClientTests: XCTestCase {
    /// Records what the client put on the wire and lets a test reply to it.
    private final class Wire {
        private(set) var sent: [FollowerToLeaderMessage] = []
        var sendSucceeds = true

        func send(_ message: FollowerToLeaderMessage) -> Bool {
            sent.append(message)
            return sendSucceeds
        }

        /// The requestId of the nth `fs.request` sent, if any.
        func requestId(at index: Int = 0) -> String? {
            let requests = sent.compactMap { message -> String? in
                if case .fsRequest(let requestId, _, _) = message { return requestId }
                return nil
            }
            return index < requests.count ? requests[index] : nil
        }

        /// The `fs.response` payloads sent back to the leader (refusals).
        var refusals: [TrayFsResponse] {
            sent.compactMap { message in
                if case .fsResponse(_, let response) = message { return response }
                return nil
            }
        }
    }

    private func makeClient(
        wire: Wire,
        timeout: TimeInterval = 5
    ) -> FsClient {
        var counter = 0
        return FsClient(
            timeout: timeout,
            makeRequestId: {
                counter += 1
                return "req-\(counter)"
            },
            send: { wire.send($0) })
    }

    /// Lets the client's `perform` suspend and reach the pending map before the
    /// test replies to it.
    private func waitForInFlight(_ client: FsClient) async {
        for _ in 0..<100 where client.inFlightCount == 0 {
            await Task.yield()
        }
    }

    // MARK: - Routing

    func testRequestsTargetTheLeaderRuntime() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readFile("/sessions/index.json") }
        await waitForInFlight(client)

        guard case .fsRequest(_, let target, let request) = wire.sent.first else {
            return XCTFail("expected an fs.request, got \(wire.sent)")
        }
        // 'leader' is what routes to executeLocalFs rather than to a peer.
        XCTAssertEqual(target, "leader")
        XCTAssertEqual(request, .readFile(path: "/sessions/index.json", encoding: .utf8))

        client.handleResponse(
            requestId: wire.requestId()!,
            response: .success(.file(content: "{}", encoding: .utf8)))
        let content = try await task.value
        XCTAssertEqual(content, "{}")
    }

    func testUnchunkedReadResolves() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readFile("/a.txt") }
        await waitForInFlight(client)
        client.handleResponse(
            requestId: wire.requestId()!,
            response: .success(.file(content: "hello", encoding: .utf8)))
        let content = try await task.value
        XCTAssertEqual(content, "hello")
        XCTAssertEqual(client.inFlightCount, 0, "a settled request must leave the pending map")
    }

    func testUnchunkedBinaryReadDecodesExactBase64Bytes() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let expected = Data([0, 1, 2, 127, 128, 254, 255])
        let task = Task { try await client.readBinaryFile("/bytes.bin") }
        await waitForInFlight(client)

        client.handleResponse(
            requestId: wire.requestId()!,
            response: .success(
                .file(content: expected.base64EncodedString(), encoding: .base64)))

        let result = try await task.value
        XCTAssertEqual(result, expected)
    }

    func testChunkedBinaryReadReassemblesBase64BeforeDecoding() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let expected = Data((0..<257).map { UInt8($0 % 251) })
        let base64 = expected.base64EncodedString()
        let split = base64.index(base64.startIndex, offsetBy: 73)
        let chunks = [String(base64[..<split]), String(base64[split...])]
        let task = Task { try await client.readBinaryFile("/chunked.bin") }
        await waitForInFlight(client)
        let id = wire.requestId()!

        for index in chunks.indices.reversed() {
            client.handleResponse(
                requestId: id,
                response: TrayFsResponse(
                    ok: true, data: .file(content: chunks[index], encoding: .base64),
                    chunkIndex: index, totalChunks: chunks.count))
        }

        let result = try await task.value
        XCTAssertEqual(result, expected)
    }

    func testBinaryReadRejectsMalformedBase64() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readBinaryFile("/broken.bin") }
        await waitForInFlight(client)

        client.handleResponse(
            requestId: wire.requestId()!,
            response: .success(.file(content: "not valid base64 !!!", encoding: .base64)))

        await assertThrowsFsError(.malformedChunking("binary read was not valid base64")) {
            _ = try await task.value
        }
    }

    func testTextWriteAndReadRoundTripUsesUtf8() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let write = Task { try await client.writeFile("/note.txt", content: "hello 🏖️") }
        await waitForInFlight(client)
        guard case .fsRequest(_, _, let request) = wire.sent[0] else {
            return XCTFail("expected write request")
        }
        XCTAssertEqual(
            request,
            .writeFile(path: "/note.txt", content: "hello 🏖️", encoding: .utf8))
        client.handleResponse(requestId: wire.requestId()!, response: .success(.void))
        try await write.value

        let read = Task { try await client.readFile("/note.txt") }
        await waitForInFlight(client)
        client.handleResponse(
            requestId: wire.requestId(at: 1)!,
            response: .success(.file(content: "hello 🏖️", encoding: .utf8)))
        let textResult = try await read.value
        XCTAssertEqual(textResult, "hello 🏖️")
    }

    func testBinaryWriteAndReadRoundTripUsesBase64() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let expected = Data([0, 1, 127, 128, 254, 255])
        let write = Task { try await client.writeBinaryFile("/bytes.bin", data: expected) }
        await waitForInFlight(client)
        guard case .fsRequest(_, _, let request) = wire.sent[0] else {
            return XCTFail("expected write request")
        }
        XCTAssertEqual(
            request,
            .writeFile(
                path: "/bytes.bin", content: expected.base64EncodedString(), encoding: .base64))
        client.handleResponse(requestId: wire.requestId()!, response: .success(.void))
        try await write.value

        let read = Task { try await client.readBinaryFile("/bytes.bin") }
        await waitForInFlight(client)
        client.handleResponse(
            requestId: wire.requestId(at: 1)!,
            response: .success(
                .file(content: expected.base64EncodedString(), encoding: .base64)))
        let binaryResult = try await read.value
        XCTAssertEqual(binaryResult, expected)
    }

    func testMkdirAndRemoveUseExistingWireCases() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let mkdir = Task { try await client.mkdir("/folder", recursive: true) }
        await waitForInFlight(client)
        guard case .fsRequest(_, _, let mkdirRequest) = wire.sent[0] else {
            return XCTFail("expected mkdir request")
        }
        XCTAssertEqual(mkdirRequest, .mkdir(path: "/folder", recursive: true))
        client.handleResponse(requestId: wire.requestId()!, response: .success(.void))
        try await mkdir.value

        let remove = Task { try await client.remove("/folder", recursive: true) }
        await waitForInFlight(client)
        guard case .fsRequest(_, _, let removeRequest) = wire.sent[1] else {
            return XCTFail("expected remove request")
        }
        XCTAssertEqual(removeRequest, .rm(path: "/folder", recursive: true))
        client.handleResponse(requestId: wire.requestId(at: 1)!, response: .success(.void))
        try await remove.value
    }

    func testReadDirDecodesEntries() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readDir("/sessions") }
        await waitForInFlight(client)
        client.handleResponse(
            requestId: wire.requestId()!,
            response: .success(
                .dirEntries([
                    TrayFsDirEntry(name: "index.json", type: .file),
                    TrayFsDirEntry(name: "archive", type: .directory),
                ])))
        let entries = try await task.value
        XCTAssertEqual(entries.map(\.name), ["index.json", "archive"])
        XCTAssertEqual(entries.map(\.type), [.file, .directory])
    }

    // MARK: - Chunk reassembly

    func testChunkedReadReassemblesInOrder() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readFile("/big.txt") }
        await waitForInFlight(client)
        let id = wire.requestId()!
        // Deliberately out of order: reassembly is by index, not arrival.
        client.handleResponse(
            requestId: id,
            response: TrayFsResponse(
                ok: true, data: .file(content: "world", encoding: .utf8),
                chunkIndex: 1, totalChunks: 2))
        client.handleResponse(
            requestId: id,
            response: TrayFsResponse(
                ok: true, data: .file(content: "hello ", encoding: .utf8),
                chunkIndex: 0, totalChunks: 2))
        let content = try await task.value
        XCTAssertEqual(content, "hello world")
    }

    func testPartialChunkedReadNeverResolves() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire, timeout: 0.2)
        let task = Task { try await client.readFile("/big.txt") }
        await waitForInFlight(client)
        // Chunk 0 of 2 arrives; the leader then goes quiet. The caller must get
        // an error, never the first chunk on its own.
        client.handleResponse(
            requestId: wire.requestId()!,
            response: TrayFsResponse(
                ok: true, data: .file(content: "hello ", encoding: .utf8),
                chunkIndex: 0, totalChunks: 2))
        await assertThrowsFsError(FsClient.FsError.timedOut(op: "readFile", path: "/big.txt")) {
            _ = try await task.value
        }
    }

    func testChunkIndexOutOfRangeFailsLoudly() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readFile("/big.txt") }
        await waitForInFlight(client)
        client.handleResponse(
            requestId: wire.requestId()!,
            response: TrayFsResponse(
                ok: true, data: .file(content: "x", encoding: .utf8),
                chunkIndex: 5, totalChunks: 2))
        await assertThrowsFsError(
            .malformedChunking("chunkIndex 5 out of range for 2")
        ) { _ = try await task.value }
    }

    func testTotalChunksChangingMidStreamFailsLoudly() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readFile("/big.txt") }
        await waitForInFlight(client)
        let id = wire.requestId()!
        client.handleResponse(
            requestId: id,
            response: TrayFsResponse(
                ok: true, data: .file(content: "a", encoding: .utf8),
                chunkIndex: 0, totalChunks: 3))
        client.handleResponse(
            requestId: id,
            response: TrayFsResponse(
                ok: true, data: .file(content: "b", encoding: .utf8),
                chunkIndex: 1, totalChunks: 2))
        await assertThrowsFsError(
            .malformedChunking("totalChunks changed from 3 to 2 mid-stream")
        ) { _ = try await task.value }
    }

    func testDuplicateChunkDoesNotSatisfyTheCount() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire, timeout: 0.2)
        let task = Task { try await client.readFile("/big.txt") }
        await waitForInFlight(client)
        let id = wire.requestId()!
        // Two copies of chunk 0 must not be mistaken for chunks 0 and 1.
        for _ in 0..<2 {
            client.handleResponse(
                requestId: id,
                response: TrayFsResponse(
                    ok: true, data: .file(content: "a", encoding: .utf8),
                    chunkIndex: 0, totalChunks: 2))
        }
        await assertThrowsFsError(.timedOut(op: "readFile", path: "/big.txt")) {
            _ = try await task.value
        }
    }

    // MARK: - Failure paths

    func testLeaderErrorPropagatesWithCode() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readFile("/missing") }
        await waitForInFlight(client)
        client.handleResponse(
            requestId: wire.requestId()!,
            response: .failure("no such file", code: "ENOENT"))
        await assertThrowsFsError(.leader(message: "no such file", code: "ENOENT")) {
            _ = try await task.value
        }
    }

    func testRequestTimesOutRatherThanHanging() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire, timeout: 0.15)
        let task = Task { try await client.stat("/slow") }
        await waitForInFlight(client)
        await assertThrowsFsError(.timedOut(op: "stat", path: "/slow")) {
            _ = try await task.value
        }
        XCTAssertEqual(client.inFlightCount, 0, "a timed-out request must be evicted")
    }

    func testWriteTimesOutAndLeaderRefusalPropagates() async throws {
        let timeoutWire = Wire()
        let timeoutClient = makeClient(wire: timeoutWire, timeout: 0.15)
        let timedOut = Task { try await timeoutClient.writeFile("/slow.txt", content: "x") }
        await waitForInFlight(timeoutClient)
        await assertThrowsFsError(.timedOut(op: "writeFile", path: "/slow.txt")) {
            _ = try await timedOut.value
        }

        let refusalWire = Wire()
        let refusalClient = makeClient(wire: refusalWire)
        let refused = Task { try await refusalClient.writeBinaryFile("/denied", data: Data()) }
        await waitForInFlight(refusalClient)
        refusalClient.handleResponse(
            requestId: refusalWire.requestId()!,
            response: .failure("permission denied", code: "EACCES"))
        await assertThrowsFsError(.leader(message: "permission denied", code: "EACCES")) {
            _ = try await refused.value
        }
    }

    func testFailedSendFailsImmediately() async throws {
        let wire = Wire()
        wire.sendSucceeds = false
        let client = makeClient(wire: wire, timeout: 60)
        // No response is ever coming, so this must not wait out the deadline.
        await assertThrowsFsError(.disconnected) {
            _ = try await client.readFile("/a.txt")
        }
    }

    func testCancelAllFailsInFlightRequests() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire, timeout: 60)
        let task = Task { try await client.readFile("/a.txt") }
        await waitForInFlight(client)
        client.cancelAll()
        await assertThrowsFsError(.disconnected) { _ = try await task.value }
        XCTAssertEqual(client.inFlightCount, 0)
    }

    func testWrongPayloadShapeIsRejected() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.readDir("/sessions") }
        await waitForInFlight(client)
        // A `file` payload cannot answer a readDir.
        client.handleResponse(
            requestId: wire.requestId()!,
            response: .success(.file(content: "x", encoding: .utf8)))
        await assertThrowsFsError(.unexpectedPayload(expected: "dirEntries", got: "file")) {
            _ = try await task.value
        }
    }

    func testWriteRejectsNonVoidSuccessPayload() async throws {
        let wire = Wire()
        let client = makeClient(wire: wire)
        let task = Task { try await client.writeFile("/a.txt", content: "x") }
        await waitForInFlight(client)
        client.handleResponse(
            requestId: wire.requestId()!, response: .success(.exists(true)))
        await assertThrowsFsError(.unexpectedPayload(expected: "void", got: "exists")) {
            _ = try await task.value
        }
    }

    func testResponseForUnknownRequestIsIgnored() {
        let wire = Wire()
        let client = makeClient(wire: wire)
        // A late reply after a timeout must not trap or resume anything.
        client.handleResponse(
            requestId: "never-sent",
            response: .success(.exists(true)))
        XCTAssertEqual(client.inFlightCount, 0)
    }

    // MARK: - Serving

    func testRefusalNamesTheOpAndIsNotSilent() {
        let refusal = FsClient.refusal(for: .writeFile(path: "/etc/x", content: "", encoding: .utf8))
        XCTAssertFalse(refusal.ok)
        XCTAssertEqual(refusal.code, "ENOTSUP")
        XCTAssertTrue(refusal.error?.contains("writeFile") == true)
        XCTAssertTrue(refusal.error?.contains("/etc/x") == true)
    }

    // MARK: - Helpers

    private func assertThrowsFsError(
        _ expected: FsClient.FsError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("expected \(expected), got success", file: file, line: line)
        } catch let error as FsClient.FsError {
            XCTAssertEqual(error, expected, file: file, line: line)
        } catch {
            XCTFail("expected \(expected), got \(error)", file: file, line: line)
        }
    }
}
