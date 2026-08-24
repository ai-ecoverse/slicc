import FileProvider
import Foundation
import SliccTrayFollower
import XCTest

@testable import SliccTrayVFS

@MainActor
final class LeaderVFSProviderTests: XCTestCase {
    private final class FakeFS: FileProviderFSClient {
        var directories: [String: [TrayFsDirEntry]] = [:]
        var stats: [String: TrayFsStat] = [:]
        var files: [String: Data] = [:]
        var error: Error?
        var removeErrors: [String: Error] = [:]
        private(set) var operations: [String] = []

        func readBinaryFile(_ path: String) async throws -> Data {
            operations.append("read:\(path)")
            if let error { throw error }
            guard let data = files[path] else {
                throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
            }
            return data
        }

        func writeBinaryFile(_ path: String, data: Data) async throws {
            operations.append("write:\(path):\(data.base64EncodedString())")
            if let error { throw error }
            files[path] = data
            stats[path] = TrayFsStat(type: .file, size: data.count, mtime: 2, ctime: 1)
            addEntry(path, type: .file)
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

        func mkdir(_ path: String, recursive: Bool) async throws {
            operations.append("mkdir:\(path):\(recursive)")
            if let error { throw error }
            directories[path] = directories[path] ?? []
            stats[path] = TrayFsStat(type: .directory, size: 0, mtime: 2, ctime: 1)
            addEntry(path, type: .directory)
        }

        func remove(_ path: String, recursive: Bool) async throws {
            operations.append("rm:\(path):\(recursive)")
            if let removeError = removeErrors[path] { throw removeError }
            if let error { throw error }
            let prefix = path + "/"
            if directories[path]?.isEmpty == false && !recursive {
                throw FsClient.FsError.leader(message: "not empty", code: "ENOTEMPTY")
            }
            guard stats[path] != nil || files[path] != nil || directories[path] != nil else {
                throw FsClient.FsError.leader(message: "missing", code: "ENOENT")
            }
            files = files.filter { $0.key != path && !$0.key.hasPrefix(prefix) }
            stats = stats.filter { $0.key != path && !$0.key.hasPrefix(prefix) }
            directories = directories.filter { $0.key != path && !$0.key.hasPrefix(prefix) }
            let parent = (path as NSString).deletingLastPathComponent
            let name = (path as NSString).lastPathComponent
            directories[parent.isEmpty ? "/" : parent]?.removeAll { $0.name == name }
        }

        private func addEntry(_ path: String, type: TrayFsNodeType) {
            let parent = (path as NSString).deletingLastPathComponent
            let parentPath = parent.isEmpty ? "/" : parent
            let name = (path as NSString).lastPathComponent
            var entries = directories[parentPath] ?? []
            if !entries.contains(where: { $0.name == name }) {
                entries.append(TrayFsDirEntry(name: name, type: type))
            }
            directories[parentPath] = entries
        }
    }

    private final class FakeConnection: FileProviderFSConnection {
        let fs: FakeFS
        private(set) var disconnected = false

        init(fs: FakeFS) { self.fs = fs }
        func readBinaryFile(_ path: String) async throws -> Data { try await fs.readBinaryFile(path) }
        func writeBinaryFile(_ path: String, data: Data) async throws {
            try await fs.writeBinaryFile(path, data: data)
        }
        func readDir(_ path: String) async throws -> [TrayFsDirEntry] { try await fs.readDir(path) }
        func stat(_ path: String) async throws -> TrayFsStat { try await fs.stat(path) }
        func mkdir(_ path: String, recursive: Bool) async throws {
            try await fs.mkdir(path, recursive: recursive)
        }
        func remove(_ path: String, recursive: Bool) async throws {
            try await fs.remove(path, recursive: recursive)
        }
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

    func testItemBuildsMetadataAndCapabilitiesPerNodeType() throws {
        let stat = TrayFsStat(type: .file, size: 42, mtime: 1_750_000_000_000, ctime: 1_740_000_000_000)
        let item = try LeaderVFSItem(path: "/docs/report.pdf", stat: stat)

        XCTAssertEqual(item.filename, "report.pdf")
        XCTAssertEqual(try VFSItemIdentity.path(for: item.parentItemIdentifier), "/docs")
        XCTAssertEqual(item.documentSize, 42)
        XCTAssertEqual(item.contentModificationDate, Date(timeIntervalSince1970: 1_750_000_000))
        XCTAssertTrue(item.capabilities.contains(.allowsReading))
        XCTAssertTrue(item.capabilities.contains(.allowsWriting))
        XCTAssertTrue(item.capabilities.contains(.allowsRenaming))
        XCTAssertTrue(item.capabilities.contains(.allowsReparenting))
        XCTAssertTrue(item.capabilities.contains(.allowsDeleting))

        let directory = try LeaderVFSItem(
            path: "/docs", stat: TrayFsStat(type: .directory, size: 0, mtime: 0, ctime: 0))
        XCTAssertTrue(directory.capabilities.contains(.allowsContentEnumerating))
        XCTAssertTrue(directory.capabilities.contains(.allowsAddingSubItems))
        XCTAssertTrue(directory.capabilities.contains(.allowsRenaming))
        XCTAssertTrue(directory.capabilities.contains(.allowsReparenting))
        XCTAssertTrue(directory.capabilities.contains(.allowsDeleting))

        let root = try LeaderVFSItem(path: "/")
        XCTAssertTrue(root.capabilities.contains(.allowsAddingSubItems))
        XCTAssertFalse(root.capabilities.contains(.allowsRenaming))
        XCTAssertFalse(root.capabilities.contains(.allowsDeleting))

        let symlink = try LeaderVFSItem(
            path: "/link", stat: TrayFsStat(type: .symlink, size: 1, mtime: 0, ctime: 0))
        XCTAssertTrue(symlink.capabilities.contains(.allowsReading))
        XCTAssertFalse(symlink.capabilities.contains(.allowsWriting))
        XCTAssertFalse(symlink.capabilities.contains(.allowsDeleting))
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

    func testCreateFileAndDirectoryAdvanceAnchorAndReturnSignalTargets() async throws {
        let fs = FakeFS()
        fs.directories["/"] = []
        let provider = LeaderVFSProvider(fs: fs)
        let anchor = provider.currentSyncAnchor()
        let bytes = Data([0, 1, 127, 128, 255])

        let file = try await provider.createItem(
            parentIdentifier: .rootContainer, filename: "bytes.bin", isDirectory: false,
            contents: bytes)
        let directory = try await provider.createItem(
            parentIdentifier: .rootContainer, filename: "notes", isDirectory: true,
            contents: nil)

        XCTAssertEqual(file.item?.path, "/bytes.bin")
        XCTAssertEqual(directory.item?.path, "/notes")
        XCTAssertEqual(fs.files["/bytes.bin"], bytes)
        XCTAssertNotEqual(provider.currentSyncAnchor(), anchor)
        XCTAssertEqual(Set(file.containersToSignal), [.workingSet, .rootContainer])
        XCTAssertTrue(fs.operations.contains("mkdir:/notes:false"))
    }

    func testModifyFileEditsRenamesAndMovesExactBytes() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [
            TrayFsDirEntry(name: "from", type: .directory),
            TrayFsDirEntry(name: "to", type: .directory),
        ]
        fs.directories["/from"] = [TrayFsDirEntry(name: "draft.bin", type: .file)]
        fs.directories["/to"] = []
        fs.stats["/from"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/to"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/from/draft.bin"] = TrayFsStat(type: .file, size: 3, mtime: 1, ctime: 1)
        fs.files["/from/draft.bin"] = Data([1, 2, 3])
        let provider = LeaderVFSProvider(fs: fs)
        let source = try VFSItemIdentity.identifier(for: "/from/draft.bin")
        let destinationParent = try VFSItemIdentity.identifier(for: "/to")
        let replacement = Data([0, 127, 128, 254, 255])
        let anchor = provider.currentSyncAnchor()

        let result = try await provider.modifyItem(
            identifier: source, parentIdentifier: destinationParent, filename: "final.bin",
            contents: replacement)

        XCTAssertNil(fs.files["/from/draft.bin"])
        XCTAssertEqual(fs.files["/to/final.bin"], replacement)
        XCTAssertEqual(result.item?.path, "/to/final.bin")
        XCTAssertNotEqual(provider.currentSyncAnchor(), anchor)
        XCTAssertEqual(
            Set(result.containersToSignal),
            [.workingSet, destinationParent, try VFSItemIdentity.identifier(for: "/from")])
    }

    func testModifyDirectoryRecursivelyMovesChildren() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "old", type: .directory)]
        fs.directories["/old"] = [TrayFsDirEntry(name: "nested", type: .directory)]
        fs.directories["/old/nested"] = [TrayFsDirEntry(name: "file.bin", type: .file)]
        fs.stats["/old"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/old/nested"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/old/nested/file.bin"] = TrayFsStat(type: .file, size: 4, mtime: 1, ctime: 1)
        fs.files["/old/nested/file.bin"] = Data([5, 6, 7, 8])
        let provider = LeaderVFSProvider(fs: fs)

        let result = try await provider.modifyItem(
            identifier: VFSItemIdentity.identifier(for: "/old"),
            parentIdentifier: .rootContainer, filename: "new", contents: nil)

        XCTAssertEqual(result.item?.path, "/new")
        XCTAssertEqual(fs.files["/new/nested/file.bin"], Data([5, 6, 7, 8]))
        XCTAssertNil(fs.directories["/old"])
        XCTAssertTrue(fs.operations.contains("rm:/old:true"))
    }

    func testModifySurfacesRollbackFailureWhenDestinationCleanupFails() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "source.bin", type: .file)]
        fs.stats["/source.bin"] = TrayFsStat(type: .file, size: 3, mtime: 1, ctime: 1)
        fs.files["/source.bin"] = Data([1, 2, 3])
        fs.removeErrors["/source.bin"] = FsClient.FsError.leader(
            message: "source busy", code: "EBUSY")
        let cleanupError = FsClient.FsError.leader(message: "cleanup denied", code: "EACCES")
        fs.removeErrors["/destination.bin"] = cleanupError
        let provider = LeaderVFSProvider(fs: fs)

        await assertFsFailure(cleanupError) {
            _ = try await provider.modifyItem(
                identifier: VFSItemIdentity.identifier(for: "/source.bin"),
                parentIdentifier: .rootContainer, filename: "destination.bin", contents: nil)
        }

        XCTAssertEqual(fs.files["/destination.bin"], Data([1, 2, 3]))
        XCTAssertTrue(fs.operations.contains("rm:/destination.bin:true"))
    }

    func testDeleteHonorsRecursiveOptionAndIsIdempotent() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "folder", type: .directory)]
        fs.directories["/folder"] = [TrayFsDirEntry(name: "file.txt", type: .file)]
        fs.stats["/folder"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/folder/file.txt"] = TrayFsStat(type: .file, size: 1, mtime: 1, ctime: 1)
        fs.files["/folder/file.txt"] = Data("x".utf8)
        let provider = LeaderVFSProvider(fs: fs)
        let identifier = try VFSItemIdentity.identifier(for: "/folder")

        await assertMappedFailure(.directoryNotEmpty) {
            _ = try await provider.deleteItem(identifier: identifier, recursive: false)
        }
        let result = try await provider.deleteItem(identifier: identifier, recursive: true)
        _ = try await provider.deleteItem(identifier: identifier, recursive: true)

        XCTAssertNil(fs.directories["/folder"])
        XCTAssertNil(result.item)
        XCTAssertEqual(Set(result.containersToSignal), [.workingSet, .rootContainer])
    }

    func testMutationFailuresMapToNativeFileProviderErrors() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "exists.txt", type: .file)]
        fs.stats["/exists.txt"] = TrayFsStat(type: .file, size: 1, mtime: 1, ctime: 1)
        fs.files["/exists.txt"] = Data("x".utf8)
        let provider = LeaderVFSProvider(fs: fs)

        await assertMappedFailure(.filenameCollision) {
            _ = try await provider.createItem(
                parentIdentifier: .rootContainer, filename: "exists.txt", isDirectory: false,
                contents: Data())
        }

        fs.error = FsClient.FsError.disconnected
        await assertMappedFailure(.serverUnreachable) {
            _ = try await provider.createItem(
                parentIdentifier: .rootContainer, filename: "offline.txt", isDirectory: false,
                contents: Data())
        }

        fs.error = FsClient.FsError.leader(message: "stat denied", code: "EACCES")
        await assertMappedFailure(.cannotSynchronize) {
            _ = try await provider.createItem(
                parentIdentifier: .rootContainer, filename: "denied.txt", isDirectory: false,
                contents: Data())
        }

        fs.error = FsClient.FsError.leader(message: "denied", code: "EACCES")
        await assertMappedFailure(.deletionRejected) {
            _ = try await provider.deleteItem(
                identifier: VFSItemIdentity.identifier(for: "/exists.txt"), recursive: false)
        }
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

    func testTrashContainerEnumeratesEmptyWithoutTalkingToTheLeader() async throws {
        let fs = FakeFS()
        let provider = LeaderVFSProvider(fs: fs)

        XCTAssertNoThrow(try provider.enumerator(for: .trashContainer))
        let items = try await provider.items(for: .trashContainer)

        XCTAssertTrue(items.isEmpty)
        XCTAssertTrue(fs.operations.isEmpty)
    }

    func testTrashEnumeratorChangeSyncStaysSilent() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "hello.txt", type: .file)]
        fs.stats["/hello.txt"] = TrayFsStat(type: .file, size: 5, mtime: 2, ctime: 1)
        let provider = LeaderVFSProvider(fs: fs)
        _ = try await provider.items(for: .rootContainer)
        let operationCount = fs.operations.count
        let enumerator = try provider.enumerator(for: .trashContainer)
        let observer = RecordingChangeObserver()

        enumerator.enumerateChanges(for: observer, from: provider.currentSyncAnchor())
        for _ in 0..<100 where !observer.finished { await Task.yield() }

        XCTAssertTrue(observer.finished)
        XCTAssertNil(observer.error)
        XCTAssertTrue(observer.updated.isEmpty)
        XCTAssertTrue(observer.deleted.isEmpty)
        XCTAssertEqual(fs.operations.count, operationCount)
    }

    func testEnumeratorValidationAndNativeErrorMappingLiveInTrayKit() throws {
        let provider = LeaderVFSProvider(fs: FakeFS())
        XCTAssertNoThrow(try provider.enumerator(for: .rootContainer))
        XCTAssertNoThrow(try provider.enumerator(for: .workingSet))
        XCTAssertNoThrow(try provider.enumerator(for: .trashContainer))

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
        assertMapped(FsClient.FsError.leader(message: "denied", code: "EACCES"), is: .cannotSynchronize)
        assertMapped(VFSProviderError.filenameCollision, is: .filenameCollision)
        assertMapped(VFSProviderError.directoryNotEmpty, is: .directoryNotEmpty)
        assertMapped(VFSProviderError.deletionRejected, is: .deletionRejected)
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
        // The idle Task hops back onto the main actor after `idleTimeout`.
        // A single sleep can resume before that hop on a loaded CI runner,
        // so poll until disconnect (or a bounded budget) instead.
        for _ in 0..<40 where !connection.disconnected {
            try await Task.sleep(nanoseconds: 10_000_000)
        }

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

        let write = Task { try await connection.writeBinaryFile("/file.bin", data: expected) }
        for _ in 0..<100 where connector.sent.count < 3 { await Task.yield() }
        let writeRequest = try JSONDecoder().decode(
            FollowerToLeaderMessage.self, from: connector.sent[2])
        guard case .fsRequest(let writeID, _, let operation) = writeRequest else {
            return XCTFail("expected routed write request")
        }
        XCTAssertEqual(
            operation,
            .writeFile(
                path: "/file.bin", content: expected.base64EncodedString(), encoding: .base64))
        connector.receive(
            try JSONEncoder().encode(
                LeaderToFollowerMessage.fsResponse(
                    requestId: writeID, response: .success(.void))))
        try await write.value

        let interrupted = Task { try await connection.writeBinaryFile("/interrupted.bin", data: expected) }
        for _ in 0..<100 where connector.sent.count < 4 { await Task.yield() }
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

    private func assertMappedFailure(
        _ expected: NSFileProviderError.Code,
        file: StaticString = #filePath,
        line: UInt = #line,
        operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("expected mapped error \(expected)", file: file, line: line)
        } catch {
            let mapped = VFSProviderErrorMapper.map(error) as NSError
            XCTAssertEqual(mapped.domain, NSFileProviderErrorDomain, file: file, line: line)
            XCTAssertEqual(mapped.code, expected.rawValue, file: file, line: line)
        }
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

private final class RecordingChangeObserver: NSObject, NSFileProviderChangeObserver {
    private(set) var updated: [any NSFileProviderItem] = []
    private(set) var deleted: [NSFileProviderItemIdentifier] = []
    private(set) var error: Error?
    private(set) var finished = false

    func didUpdate(_ updatedItems: [any NSFileProviderItem]) { updated = updatedItems }
    func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) {
        deleted = deletedItemIdentifiers
    }
    func finishEnumeratingChanges(upTo _: NSFileProviderSyncAnchor, moreComing _: Bool) {
        finished = true
    }
    func finishEnumeratingWithError(_ error: any Error) {
        self.error = error
        finished = true
    }
}
