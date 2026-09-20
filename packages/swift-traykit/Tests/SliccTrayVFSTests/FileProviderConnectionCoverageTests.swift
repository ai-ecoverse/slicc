import Foundation
import SliccTrayFollower
import XCTest

@testable import SliccTrayVFS

@MainActor
final class FileProviderConnectionCoverageTests: XCTestCase {
    private func connectedPool(_ fs: FakeFS) throws -> (FileProviderFSClientPool, FakeConnection) {
        let connection = FakeConnection(fs: fs)
        let pool = FileProviderFSClientPool(
            connectionTimeout: 1,
            idleTimeout: 10,
            loadCredentials: { try? testCredentials() },
            buildConnection: { _ in connection })
        return (pool, connection)
    }

    func testDefaultPoolConvenienceInitIsConstructible() {
        
        
        _ = FileProviderFSClientPool(connectionTimeout: 0.05, idleTimeout: 0.05)
    }

    func testPoolForwardsEveryFSOperationAndDisconnectsWaiters() async throws {
        let fs = FakeFS()
        fs.directories["/"] = []
        fs.files["/a.bin"] = Data([7])
        fs.stats["/a.bin"] = TrayFsStat(type: .file, size: 1, mtime: 1, ctime: 1)
        let (pool, connection) = try connectedPool(fs)

        let bytes = try await pool.readBinaryFile("/a.bin")
        XCTAssertEqual(bytes, Data([7]))
        try await pool.writeBinaryFile("/b.bin", data: Data([8]))
        try await pool.mkdir("/dir", recursive: true)
        try await pool.remove("/b.bin", recursive: false)
        _ = try await pool.stat("/a.bin")
        _ = try await pool.readDir("/")

        pool.disconnect()
        XCTAssertTrue(connection.disconnected)
    }

    func testPoolSharesOneInFlightAttemptAndSurfacesBuildFailure() async throws {
        let fs = FakeFS()
        fs.directories["/"] = []
        fs.files["/a.bin"] = Data([1])
        fs.stats["/a.bin"] = TrayFsStat(type: .file, size: 1, mtime: 1, ctime: 1)
        var resume: CheckedContinuation<FileProviderFSConnection, Error>?
        var buildCount = 0
        let pool = FileProviderFSClientPool(
            connectionTimeout: 2,
            idleTimeout: 10,
            loadCredentials: { try? testCredentials() },
            buildConnection: { _ in
                buildCount += 1
                return try await withCheckedThrowingContinuation { continuation in
                    resume = continuation
                }
            })

        async let dir = pool.readDir("/")
        async let file = pool.readBinaryFile("/a.bin")
        for _ in 0..<200 where resume == nil { await Task.yield() }
        resume?.resume(returning: FakeConnection(fs: fs))
        let dirEntries = try await dir
        let fileBytes = try await file
        XCTAssertEqual(dirEntries, [])
        XCTAssertEqual(fileBytes, Data([1]))
        XCTAssertEqual(buildCount, 1)

        let failing = FileProviderFSClientPool(
            connectionTimeout: 1,
            idleTimeout: 1,
            loadCredentials: { try? testCredentials() },
            buildConnection: { _ in throw VFSProviderError.serverUnreachable })
        await assertVFSFailure(.serverUnreachable) { _ = try await failing.stat("/a.bin") }
    }

    func testPoolDisconnectCancelsInFlightConnectAndDropsLateSuccess() async throws {
        let late = FakeConnection(fs: FakeFS())
        var resume: CheckedContinuation<FileProviderFSConnection, Error>?
        let pool = FileProviderFSClientPool(
            connectionTimeout: 5,
            idleTimeout: 10,
            loadCredentials: { try? testCredentials() },
            buildConnection: { _ in
                try await withCheckedThrowingContinuation { continuation in
                    resume = continuation
                }
            })
        let hanging = Task { try await pool.mkdir("/x", recursive: false) }
        for _ in 0..<200 where resume == nil { await Task.yield() }
        pool.disconnect()
        await assertVFSFailure(.serverUnreachable) { _ = try await hanging.value }
        resume?.resume(returning: late)
        for _ in 0..<100 where !late.disconnected { await Task.yield() }
        XCTAssertTrue(late.disconnected)
    }

    func testTrayConnectionStartFailureAndHelloSendFailure() async {
        let failing = FakeTrayConnector()
        failing.startError = VFSProviderError.serverUnreachable
        let failed = TrayFileProviderConnection(connector: failing)
        await assertVFSFailure(.serverUnreachable) { try await failed.start() }

        let silent = FakeTrayConnector()
        silent.sendSucceeds = false
        let connection = TrayFileProviderConnection(connector: silent)
        await assertVFSFailure(.serverUnreachable) { try await connection.start() }
    }

    func testTrayConnectionCancelDuringStartStopsTheConnector() async throws {
        let connector = FakeTrayConnector()
        connector.hangStart = true
        let connection = TrayFileProviderConnection(connector: connector)
        let task = Task { try await connection.start() }
        for _ in 0..<50 { await Task.yield() }
        task.cancel()
        do {
            try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError || error is VFSProviderError)
        }
        XCTAssertGreaterThanOrEqual(connector.stopCount, 1)
    }

    func testTrayConnectionRoutesPingChunksRefusalsAndIgnoresNoise() async throws {
        let connector = FakeTrayConnector()
        let connection = TrayFileProviderConnection(connector: connector)
        try await connection.start()
        connector.announceReconnect(attempt: 1)
        connector.announceInfo(trayId: "tray", participantCount: 2)
        connector.announceCandidate()

        connector.receive(try JSONEncoder().encode(LeaderToFollowerMessage.ping))
        connector.receive(Data("not-json".utf8))
        connector.receive(
            try JSONEncoder().encode(LeaderToFollowerMessage.error(error: "ignored")))
        connector.receive(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.fsRequest(
                    requestId: "leader-req", request: .stat(path: "/etc"))))

        for _ in 0..<100 where connector.sent.count < 3 { await Task.yield() }
        let messages = try connector.sent.map {
            try JSONDecoder().decode(FollowerToLeaderMessage.self, from: $0)
        }
        XCTAssertTrue(
            messages.contains {
                if case .pong = $0 { return true }
                return false
            })
        XCTAssertTrue(
            messages.contains {
                if case .fsResponse(_, let response) = $0 { return response.code == "ENOTSUP" }
                return false
            })

        let expected = Data([1, 2, 3, 4])
        let read = Task { try await connection.readBinaryFile("/chunked.bin") }
        for _ in 0..<100 where connector.sent.count < 4 { await Task.yield() }
        let request = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: connector.sent[connector.sent.count - 1])
        guard case .fsRequest(let requestID, _, _) = request else {
            return XCTFail("expected fs request")
        }
        let payload = try JSONEncoder().encode(
            LeaderToFollowerMessage.fsResponse(
                requestId: requestID,
                response: .success(
                    .file(content: expected.base64EncodedString(), encoding: .base64))))
        let text = try XCTUnwrap(String(data: payload, encoding: .utf8))
        for frame in TrayChunkFraming.frameChunks(text, chunkId: "cov") {
            connector.receive(try JSONEncoder().encode(frame))
        }
        let chunked = try await read.value
        XCTAssertEqual(chunked, expected)

        let dir = Task { try await connection.readDir("/") }
        for _ in 0..<100 where connector.sent.count < 5 { await Task.yield() }
        let dirRequest = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: connector.sent[connector.sent.count - 1])
        guard case .fsRequest(let dirID, _, _) = dirRequest else {
            return XCTFail("expected dir request")
        }
        connector.receive(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.fsResponse(
                    requestId: dirID, response: .success(.dirEntries([])))))
        let dirEntries = try await dir.value
        XCTAssertEqual(dirEntries, [])

        try await replyVoid(connection, connector) { try await connection.mkdir("/n", recursive: true) }
        try await replyVoid(connection, connector) {
            try await connection.remove("/n", recursive: true)
        }
        let statTask = Task { try await connection.stat("/") }
        for _ in 0..<100 where connector.sent.count < 8 { await Task.yield() }
        let statRequest = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: connector.sent[connector.sent.count - 1])
        guard case .fsRequest(let statID, _, _) = statRequest else {
            return XCTFail("expected stat request")
        }
        connector.receive(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.fsResponse(
                    requestId: statID,
                    response: .success(.stat(TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1))))))
        let stat = try await statTask.value
        XCTAssertEqual(stat.type, .directory)

        connector.giveUp("gave up")
        await assertFsFailure(.disconnected) { _ = try await connection.readDir("/") }
        connection.disconnect()
    }

    func testConnectToUnreachableJoinURLCanBeCancelled() async {
        let url = URL(string: "https://127.0.0.1:1/join/coverage")!
        let task = Task { try await TrayFileProviderConnection.connect(joinURL: url) }
        for _ in 0..<20 { await Task.yield() }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected connect to fail or cancel")
        } catch {
            XCTAssertTrue(error is CancellationError || error is VFSProviderError || error is URLError)
        }
    }

    private func replyVoid(
        _ connection: TrayFileProviderConnection,
        _ connector: FakeTrayConnector,
        operation: @escaping () async throws -> Void
    ) async throws {
        let before = connector.sent.count
        let task = Task { try await operation() }
        for _ in 0..<100 where connector.sent.count <= before { await Task.yield() }
        let request = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: connector.sent[connector.sent.count - 1])
        guard case .fsRequest(let requestID, _, _) = request else {
            return XCTFail("expected fs request")
        }
        connector.receive(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.fsResponse(requestId: requestID, response: .success(.void))))
        try await task.value
    }
}
