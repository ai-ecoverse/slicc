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
}
