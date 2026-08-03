import FileProvider
import Foundation
import XCTest

@testable import SliccTrayKit

@MainActor
final class LeaderVFSProviderTests: XCTestCase {
    private final class FakeFS: FileProviderFSClient {
        var directories: [String: [TrayFsDirEntry]] = [:]
        var stats: [String: TrayFsStat] = [:]
        var files: [String: Data] = [:]
        var error: Error?
        private(set) var operations: [String] = []

        func readBinaryFile(_ path: String) async throws -> Data {
            operations.append("read:\(path)")
            if let error { throw error }
            guard let data = files[path] else {
                throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
            }
            return data
        }

        func readDir(_ path: String) async throws -> [TrayFsDirEntry] {
            operations.append("dir:\(path)")
            if let error { throw error }
            guard let entries = directories[path] else {
                throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
            }
            return entries
        }

        func stat(_ path: String) async throws -> TrayFsStat {
            operations.append("stat:\(path)")
            if let error { throw error }
            guard let stat = stats[path] else {
                throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
            }
            return stat
        }
    }

    private final class FakeConnection: FileProviderFSConnection {
        let fs: FakeFS
        private(set) var disconnected = false

        init(fs: FakeFS) { self.fs = fs }
        func readBinaryFile(_ path: String) async throws -> Data { try await fs.readBinaryFile(path) }
        func readDir(_ path: String) async throws -> [TrayFsDirEntry] { try await fs.readDir(path) }
        func stat(_ path: String) async throws -> TrayFsStat { try await fs.stat(path) }
        func disconnect() { disconnected = true }
    }

    private final class FakeTrayConnector: FileProviderTrayConnector {
        var delegate: TrayFollowerConnectorDelegate?
        private(set) var sent: [Data] = []
        private(set) var stopCount = 0
        private let callbackConnector = TrayFollowerConnector(
            joinUrl: URL(string: "https://tray.example/join/redacted")!)

        func start() async throws {
            delegate?.connector(
                callbackConnector,
                didConnect: { [weak self] data in
                    self?.sent.append(data)
                    return true
                })
        }

        func stop() { stopCount += 1 }

        func receive(_ data: Data) {
            delegate?.connector(callbackConnector, didReceiveData: data)
        }

        func disconnect() {
            delegate?.connectorDidDisconnect(callbackConnector, reason: "test disconnect")
        }
    }

    func testIdentifierRoundTripsRootNestedUnicodeAndAwkwardPaths() throws {
        XCTAssertEqual(try VFSItemIdentity.identifier(for: "/"), .rootContainer)
        XCTAssertEqual(try VFSItemIdentity.path(for: .rootContainer), "/")

        let paths = [
            "/folder/file.txt",
            "/folder/file.txt/",
            "/日本語/🏖️ notes.txt",
            "/spaces and %?#: brackets[1]/file",
        ]
        for path in paths {
            let identifier = try VFSItemIdentity.identifier(for: path)
            XCTAssertFalse(identifier.rawValue.contains("/"), "identifiers must be opaque to Files.app")
            XCTAssertEqual(
                try VFSItemIdentity.path(for: identifier),
                path.hasSuffix("/") ? String(path.dropLast()) : path)
        }
    }

    func testInvalidIdentifierAndEscapingPathAreRejected() {
        XCTAssertThrowsError(
            try VFSItemIdentity.path(
                for: NSFileProviderItemIdentifier(rawValue: "not-a-vfs-identifier")))
        XCTAssertThrowsError(try VFSItemIdentity.identifier(for: "relative"))
        XCTAssertThrowsError(try VFSItemIdentity.identifier(for: "/../../proc"))
    }

    func testItemBuildsMetadataAndReadOnlyCapabilitiesFromStat() throws {
        let stat = TrayFsStat(type: .file, size: 42, mtime: 1_750_000_000_000, ctime: 1_740_000_000_000)
        let item = try LeaderVFSItem(path: "/docs/report.pdf", stat: stat)

        XCTAssertEqual(item.filename, "report.pdf")
        XCTAssertEqual(try VFSItemIdentity.path(for: item.parentItemIdentifier), "/docs")
        XCTAssertEqual(item.documentSize, 42)
        XCTAssertEqual(item.contentModificationDate, Date(timeIntervalSince1970: 1_750_000_000))
        XCTAssertTrue(item.capabilities.contains(.allowsReading))
        XCTAssertFalse(item.capabilities.contains(.allowsWriting))

        let directory = try LeaderVFSItem(
            path: "/docs", stat: TrayFsStat(type: .directory, size: 0, mtime: 0, ctime: 0))
        XCTAssertTrue(directory.capabilities.contains(.allowsContentEnumerating))
        XCTAssertFalse(directory.capabilities.contains(.allowsAddingSubItems))
    }

    func testRootEnumerationUsesReadDirAndStatAndExcludesProc() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [
            TrayFsDirEntry(name: "proc", type: .directory),
            TrayFsDirEntry(name: "docs", type: .directory),
            TrayFsDirEntry(name: "hello.txt", type: .file),
        ]
        fs.stats["/docs"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/hello.txt"] = TrayFsStat(type: .file, size: 5, mtime: 2, ctime: 1)
        let provider = LeaderVFSProvider(fs: fs)

        let items = try await provider.items(for: .rootContainer)

        XCTAssertEqual(items.map(\.filename), ["docs", "hello.txt"])
        XCTAssertEqual(fs.operations, ["dir:/", "stat:/docs", "stat:/hello.txt"])
        let workingSet = try await provider.items(for: .workingSet)
        XCTAssertEqual(workingSet.map(\.path), ["/docs", "/hello.txt"])
        XCTAssertFalse(fs.operations.contains { $0.contains("/proc") })
    }

    func testFetchContentsPreservesLargeBinaryBytes() async throws {
        let fs = FakeFS()
        let data = Data((0..<(1024 * 1024)).map { UInt8($0 % 251) })
        fs.files["/image.bin"] = data
        fs.stats["/image.bin"] = TrayFsStat(type: .file, size: data.count, mtime: 3, ctime: 2)
        let provider = LeaderVFSProvider(fs: fs)
        let identifier = try VFSItemIdentity.identifier(for: "/image.bin")

        let fetched = try await provider.fetchContents(for: identifier)

        XCTAssertEqual(fetched.0, data)
        XCTAssertEqual(fetched.1.documentSize, NSNumber(value: data.count))
        XCTAssertEqual(Set(fs.operations), ["read:/image.bin", "stat:/image.bin"])
    }

    func testChangesRefreshKnownDirectoriesAndReportUpdatesAndDeletes() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "old.txt", type: .file)]
        fs.stats["/old.txt"] = TrayFsStat(type: .file, size: 1, mtime: 1, ctime: 1)
        let provider = LeaderVFSProvider(fs: fs)
        _ = try await provider.items(for: .rootContainer)
        let anchor = provider.currentSyncAnchor()

        fs.directories["/"] = [TrayFsDirEntry(name: "new.txt", type: .file)]
        fs.stats["/new.txt"] = TrayFsStat(type: .file, size: 2, mtime: 2, ctime: 2)
        let changes = try await provider.changes(from: anchor)

        XCTAssertEqual(changes.updated.map(\.path), ["/new.txt"])
        XCTAssertEqual(changes.deleted, [try VFSItemIdentity.identifier(for: "/old.txt")])
        XCTAssertNotEqual(changes.anchor, anchor)
    }

    func testChangesPurgeDeletedDirectoryDescendantsWithoutRefreshingStalePaths() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "gone", type: .directory)]
        fs.directories["/gone"] = [
            TrayFsDirEntry(name: "nested", type: .directory),
            TrayFsDirEntry(name: "leaf.txt", type: .file),
        ]
        fs.directories["/gone/nested"] = [TrayFsDirEntry(name: "deep.txt", type: .file)]
        fs.stats["/gone"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/gone/nested"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/gone/leaf.txt"] = TrayFsStat(type: .file, size: 1, mtime: 1, ctime: 1)
        fs.stats["/gone/nested/deep.txt"] = TrayFsStat(type: .file, size: 1, mtime: 1, ctime: 1)
        let provider = LeaderVFSProvider(fs: fs)
        _ = try await provider.items(for: .rootContainer)
        _ = try await provider.items(for: VFSItemIdentity.identifier(for: "/gone"))
        _ = try await provider.items(for: VFSItemIdentity.identifier(for: "/gone/nested"))
        let anchor = provider.currentSyncAnchor()
        let operationCount = fs.operations.count

        fs.directories["/"] = []
        fs.directories["/gone"] = nil
        fs.directories["/gone/nested"] = nil
        let changes = try await provider.changes(from: anchor)

        let deletedPaths = try changes.deleted.map { try VFSItemIdentity.path(for: $0) }
        XCTAssertEqual(
            Set(deletedPaths),
            ["/gone", "/gone/nested", "/gone/leaf.txt", "/gone/nested/deep.txt"])
        let changeOperations = fs.operations.dropFirst(operationCount)
        XCTAssertFalse(changeOperations.contains("dir:/gone"))
        XCTAssertFalse(changeOperations.contains("dir:/gone/nested"))
        let workingSet = try await provider.items(for: .workingSet)
        XCTAssertTrue(workingSet.isEmpty)
    }

    func testEnumeratorValidationAndNativeErrorMappingLiveInTrayKit() throws {
        let provider = LeaderVFSProvider(fs: FakeFS())
        XCTAssertNoThrow(try provider.enumerator(for: .rootContainer))
        XCTAssertNoThrow(try provider.enumerator(for: .workingSet))

        XCTAssertThrowsError(
            try provider.enumerator(
                for: NSFileProviderItemIdentifier(rawValue: "not-a-vfs-identifier"))
        ) { error in
            let mapped = error as NSError
            XCTAssertEqual(mapped.domain, NSFileProviderErrorDomain)
            XCTAssertEqual(mapped.code, NSFileProviderError.Code.noSuchItem.rawValue)
        }
    }

    func testErrorMappingUsesNativeFileProviderCodes() {
        assertMapped(VFSProviderError.missingCredentials, is: .notAuthenticated)
        assertMapped(VFSProviderError.serverUnreachable, is: .serverUnreachable)
        assertMapped(FsClient.FsError.timedOut(op: "stat", path: "/slow"), is: .serverUnreachable)
        assertMapped(FsClient.FsError.disconnected, is: .serverUnreachable)
        assertMapped(FsClient.FsError.leader(message: "missing", code: "ENOENT"), is: .noSuchItem)
    }

    func testConnectionPoolMissingCredentialsFailsImmediately() async {
        let pool = FileProviderFSClientPool(
            connectionTimeout: 1,
            idleTimeout: 1,
            loadCredentials: { nil },
            buildConnection: { _ in
                XCTFail("must not connect")
                throw VFSProviderError.serverUnreachable
            })
        await assertVFSFailure(.missingCredentials) { _ = try await pool.readDir("/") }
    }

    func testConnectionPoolTimesOutSetup() async throws {
        let credentials = TrayCredentials(
            joinURL: try XCTUnwrap(URL(string: "https://tray.example/join/redacted")),
            trayID: "tray", displayName: nil, lastConnectedAt: Date())
        let pool = FileProviderFSClientPool(
            connectionTimeout: 0.05,
            idleTimeout: 1,
            loadCredentials: { credentials },
            buildConnection: { _ in
                try await Task.sleep(nanoseconds: 5_000_000_000)
                return FakeConnection(fs: FakeFS())
            })
        await assertVFSFailure(.serverUnreachable) { _ = try await pool.readDir("/") }
    }

    func testConnectionPoolTimeoutRetryIgnoresLateFirstAttemptCompletion() async throws {
        let credentials = try testCredentials()
        let lateConnection = FakeConnection(fs: FakeFS())
        let retryFS = FakeFS()
        retryFS.directories["/"] = []
        let retryConnection = FakeConnection(fs: retryFS)
        var attemptCount = 0
        var finishFirstAttempt: CheckedContinuation<FileProviderFSConnection, Error>?
        let pool = FileProviderFSClientPool(
            connectionTimeout: 0.03,
            idleTimeout: 1,
            loadCredentials: { credentials },
            buildConnection: { _ in
                attemptCount += 1
                if attemptCount == 1 {
                    return try await withCheckedThrowingContinuation { continuation in
                        finishFirstAttempt = continuation
                    }
                }
                return retryConnection
            })

        await assertVFSFailure(.serverUnreachable) { _ = try await pool.readDir("/") }
        let retryResult = try await pool.readDir("/")
        XCTAssertEqual(retryResult, [])
        finishFirstAttempt?.resume(returning: lateConnection)
        for _ in 0..<100 where !lateConnection.disconnected { await Task.yield() }

        XCTAssertEqual(attemptCount, 2)
        XCTAssertTrue(lateConnection.disconnected)
        XCTAssertFalse(retryConnection.disconnected)
    }

    func testConnectionPoolReusesSuccessAndDisconnectsWhenIdle() async throws {
        let credentials = try testCredentials()
        let fs = FakeFS()
        fs.directories["/"] = []
        fs.stats["/file"] = TrayFsStat(type: .file, size: 1, mtime: 1, ctime: 1)
        let connection = FakeConnection(fs: fs)
        var buildCount = 0
        let pool = FileProviderFSClientPool(
            connectionTimeout: 1,
            idleTimeout: 0.03,
            loadCredentials: { credentials },
            buildConnection: { _ in
                buildCount += 1
                return connection
            })

        let entries = try await pool.readDir("/")
        XCTAssertEqual(entries, [])
        _ = try await pool.stat("/file")
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(buildCount, 1)
        XCTAssertTrue(connection.disconnected)
    }

    func testTrayConnectionRoutesResponsesAndDisconnectsInflightRequests() async throws {
        let connector = FakeTrayConnector()
        let connection = TrayFileProviderConnection(connector: connector)
        try await connection.start()
        XCTAssertEqual(connector.sent.count, 1, "successful connect sends hello")

        let expected = Data([0, 127, 128, 255])
        let read = Task { try await connection.readBinaryFile("/file.bin") }
        for _ in 0..<100 where connector.sent.count < 2 { await Task.yield() }
        let request = try JSONDecoder().decode(FollowerToLeaderMessage.self, from: connector.sent[1])
        guard case .fsRequest(let requestID, _, _) = request else {
            return XCTFail("expected routed fs request")
        }
        connector.receive(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.fsResponse(
                    requestId: requestID,
                    response: .success(
                        .file(content: expected.base64EncodedString(), encoding: .base64)))))
        let result = try await read.value
        XCTAssertEqual(result, expected)

        let interrupted = Task { try await connection.stat("/slow") }
        for _ in 0..<100 where connector.sent.count < 3 { await Task.yield() }
        connector.disconnect()
        await assertFsFailure(.disconnected) { _ = try await interrupted.value }
        connection.disconnect()
        XCTAssertEqual(connector.stopCount, 1)
    }

    private func testCredentials() throws -> TrayCredentials {
        TrayCredentials(
            joinURL: try XCTUnwrap(URL(string: "https://tray.example/join/redacted")),
            trayID: "tray", displayName: nil, lastConnectedAt: Date())
    }

    private func assertMapped(
        _ error: Error,
        is expected: NSFileProviderError.Code,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let mapped = VFSProviderErrorMapper.map(error) as NSError
        XCTAssertEqual(mapped.domain, NSFileProviderErrorDomain, file: file, line: line)
        XCTAssertEqual(mapped.code, expected.rawValue, file: file, line: line)
    }

    private func assertVFSFailure(
        _ expected: VFSProviderError,
        file: StaticString = #filePath,
        line: UInt = #line,
        operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch let error as VFSProviderError {
            XCTAssertEqual(error, expected, file: file, line: line)
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }

    private func assertFsFailure(
        _ expected: FsClient.FsError,
        file: StaticString = #filePath,
        line: UInt = #line,
        operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch let error as FsClient.FsError {
            XCTAssertEqual(error, expected, file: file, line: line)
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }
}
