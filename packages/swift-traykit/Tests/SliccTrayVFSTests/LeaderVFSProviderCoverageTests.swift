import FileProvider
import Foundation
import SliccTrayFollower
import XCTest

@testable import SliccTrayVFS

@MainActor
final class LeaderVFSProviderCoverageTests: XCTestCase {
    private func seededFileFS() -> FakeFS {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "file.bin", type: .file)]
        fs.files["/file.bin"] = Data([1, 2, 3])
        fs.stats["/file.bin"] = TrayFsStat(type: .file, size: 3, mtime: 2, ctime: 1)
        return fs
    }

    func testItemLooksUpRootAndFileAndRejectsProc() async throws {
        let fs = seededFileFS()
        let provider = LeaderVFSProvider(fs: fs)

        let root = try await provider.item(for: .rootContainer)
        XCTAssertEqual(root.path, "/")
        XCTAssertEqual(root.filename, "Sliccy")

        let file = try await provider.item(for: VFSItemIdentity.identifier(for: "/file.bin"))
        XCTAssertEqual(file.documentSize, 3)

        await assertVFSFailure(.noSuchItem) {
            _ = try await provider.item(for: VFSItemIdentity.identifier(for: "/proc/self"))
        }
    }

    func testFetchContentsRejectsRoot() async {
        let provider = LeaderVFSProvider(fs: FakeFS())
        await assertVFSFailure(.noSuchItem) {
            _ = try await provider.fetchContents(for: .rootContainer)
        }
    }

    func testCreateRejectsProcAndInvalidChildNames() async throws {
        let fs = FakeFS()
        fs.directories["/"] = []
        let provider = LeaderVFSProvider(fs: fs)

        await assertVFSFailure(.notWritable) {
            _ = try await provider.createItem(
                parentIdentifier: .rootContainer, filename: "proc", isDirectory: false, contents: Data())
        }
        await assertVFSFailure(.invalidPath) {
            _ = try await provider.createItem(
                parentIdentifier: .rootContainer, filename: "..", isDirectory: false, contents: Data())
        }
        await assertVFSFailure(.invalidPath) {
            _ = try await provider.createItem(
                parentIdentifier: .rootContainer, filename: "a/b", isDirectory: false, contents: Data())
        }
        await assertVFSFailure(.invalidPath) {
            _ = try await provider.createItem(
                parentIdentifier: .rootContainer, filename: "", isDirectory: false, contents: Data())
        }
    }

    func testModifyRejectsRootProcAndMovingIntoSelf() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "folder", type: .directory)]
        fs.directories["/folder"] = []
        fs.stats["/folder"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        let provider = LeaderVFSProvider(fs: fs)
        let folder = try VFSItemIdentity.identifier(for: "/folder")

        await assertVFSFailure(.notWritable) {
            _ = try await provider.modifyItem(
                identifier: .rootContainer, parentIdentifier: .rootContainer, filename: "Sliccy",
                contents: nil)
        }
        await assertVFSFailure(.notWritable) {
            _ = try await provider.modifyItem(
                identifier: folder, parentIdentifier: .rootContainer, filename: "proc", contents: nil)
        }
        await assertVFSFailure(.invalidPath) {
            _ = try await provider.modifyItem(
                identifier: folder, parentIdentifier: folder, filename: "nested", contents: nil)
        }
    }

    func testModifyEditsFileInPlaceWithoutMoving() async throws {
        let fs = seededFileFS()
        let provider = LeaderVFSProvider(fs: fs)
        let identifier = try VFSItemIdentity.identifier(for: "/file.bin")
        let replacement = Data([9, 8, 7])

        let result = try await provider.modifyItem(
            identifier: identifier, parentIdentifier: .rootContainer, filename: "file.bin",
            contents: replacement)

        XCTAssertEqual(fs.files["/file.bin"], replacement)
        XCTAssertEqual(result.item?.path, "/file.bin")
        XCTAssertEqual(Set(result.containersToSignal), [.workingSet, .rootContainer])
    }

    func testModifyDirectoryContentsAndSymlinkAreNotWritable() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [
            TrayFsDirEntry(name: "folder", type: .directory),
            TrayFsDirEntry(name: "link", type: .symlink),
        ]
        fs.directories["/folder"] = []
        fs.stats["/folder"] = TrayFsStat(type: .directory, size: 0, mtime: 1, ctime: 1)
        fs.stats["/link"] = TrayFsStat(type: .symlink, size: 1, mtime: 1, ctime: 1)
        let provider = LeaderVFSProvider(fs: fs)

        await assertVFSFailure(.notWritable) {
            _ = try await provider.modifyItem(
                identifier: VFSItemIdentity.identifier(for: "/folder"),
                parentIdentifier: .rootContainer, filename: "folder", contents: Data([1]))
        }
        await assertVFSFailure(.notWritable) {
            _ = try await provider.modifyItem(
                identifier: VFSItemIdentity.identifier(for: "/link"),
                parentIdentifier: .rootContainer, filename: "moved-link", contents: nil)
        }
    }

    func testModifyRollbackIgnoresMissingDestination() async throws {
        let fs = FakeFS()
        fs.directories["/"] = [TrayFsDirEntry(name: "source.bin", type: .file)]
        fs.stats["/source.bin"] = TrayFsStat(type: .file, size: 3, mtime: 1, ctime: 1)
        fs.files["/source.bin"] = Data([1, 2, 3])
        let mutationError = FsClient.FsError.leader(message: "source busy", code: "EBUSY")
        fs.removeErrors["/source.bin"] = mutationError
        fs.removeErrors["/destination.bin"] = FsClient.FsError.leader(
            message: "gone", code: "ENOENT")
        let provider = LeaderVFSProvider(fs: fs)

        await assertFsFailure(mutationError) {
            _ = try await provider.modifyItem(
                identifier: VFSItemIdentity.identifier(for: "/source.bin"),
                parentIdentifier: .rootContainer, filename: "destination.bin", contents: nil)
        }
    }

    func testDeleteRejectsRootAndMapsPermissionDenied() async throws {
        let fs = seededFileFS()
        let provider = LeaderVFSProvider(fs: fs)

        await assertVFSFailure(.deletionRejected) {
            _ = try await provider.deleteItem(identifier: .rootContainer, recursive: true)
        }

        fs.removeErrors["/file.bin"] = FsClient.FsError.leader(message: "denied", code: "EPERM")
        await assertVFSFailure(.deletionRejected) {
            _ = try await provider.deleteItem(
                identifier: VFSItemIdentity.identifier(for: "/file.bin"), recursive: false)
        }
    }

    func testInvalidSyncAnchorDecodesAsZero() async throws {
        let fs = seededFileFS()
        let provider = LeaderVFSProvider(fs: fs)
        _ = try await provider.items(for: .rootContainer)
        let changes = try await provider.changes(
            from: NSFileProviderSyncAnchor(rawValue: Data("nope".utf8)))
        XCTAssertEqual(changes.updated.map(\.path), ["/file.bin"])
    }

    func testChangeLogDropsOldestEntriesPastTheCap() async throws {
        let fs = FakeFS()
        fs.directories["/"] = []
        let provider = LeaderVFSProvider(fs: fs)
        for index in 0..<101 {
            _ = try await provider.createItem(
                parentIdentifier: .rootContainer, filename: "f\(index).bin", isDirectory: false,
                contents: Data([UInt8(index % 251)]))
        }
        let changes = try await provider.changes(
            from: NSFileProviderSyncAnchor(rawValue: Data("0".utf8)))
        XCTAssertEqual(changes.updated.count, 100)
        XCTAssertFalse(changes.updated.contains(where: { $0.path == "/f0.bin" }))
        XCTAssertTrue(changes.updated.contains(where: { $0.path == "/f100.bin" }))
    }

    func testWorkingSetRefreshesRootWhenEmpty() async throws {
        let fs = seededFileFS()
        let provider = LeaderVFSProvider(fs: fs)
        let workingSet = try await provider.items(for: .workingSet)
        XCTAssertEqual(workingSet.map(\.path), ["/file.bin"])
        XCTAssertTrue(fs.operations.contains("dir:/"))
    }

    func testEnumeratorEnumeratesItemsReportsErrorsAndServesAnchors() async throws {
        let fs = seededFileFS()
        let provider = LeaderVFSProvider(fs: fs)
        let enumerator = try provider.enumerator(for: .rootContainer)
        enumerator.invalidate()

        let itemsObserver = RecordingEnumerationObserver()
        enumerator.enumerateItems(for: itemsObserver, startingAt: NSFileProviderPage(rawValue: Data()))
        await waitUntilFinished(itemsObserver.finished)
        XCTAssertEqual(itemsObserver.items.map { ($0 as? LeaderVFSItem)?.path }, ["/file.bin"])
        XCTAssertNil(itemsObserver.error)

        let changesObserver = RecordingChangeObserver()
        enumerator.enumerateChanges(for: changesObserver, from: NSFileProviderSyncAnchor(rawValue: Data()))
        await waitUntilFinished(changesObserver.finished)
        XCTAssertEqual(changesObserver.updated.map { ($0 as? LeaderVFSItem)?.path }, ["/file.bin"])
        XCTAssertNil(changesObserver.error)

        let anchor = expectation(description: "current sync anchor")
        var received: NSFileProviderSyncAnchor?
        enumerator.currentSyncAnchor { value in
            received = value
            anchor.fulfill()
        }
        await fulfillment(of: [anchor], timeout: 1)
        XCTAssertEqual(received, provider.currentSyncAnchor())

        fs.error = FsClient.FsError.disconnected
        let failedItems = RecordingEnumerationObserver()
        enumerator.enumerateItems(for: failedItems, startingAt: NSFileProviderPage(rawValue: Data()))
        await waitUntilFinished(failedItems.finished)
        XCTAssertNotNil(failedItems.error)

        let failedChanges = RecordingChangeObserver()
        enumerator.enumerateChanges(
            for: failedChanges, from: NSFileProviderSyncAnchor(rawValue: Data("0".utf8)))
        await waitUntilFinished(failedChanges.finished)
        XCTAssertNotNil(failedChanges.error)
    }

    func testErrorMappingCoversRemainingNativeCodes() {
        assertMapped(VFSProviderError.notWritable, is: .cannotSynchronize)
        assertMapped(VFSProviderError.invalidIdentifier, is: .noSuchItem)
        assertMapped(VFSProviderError.invalidPath, is: .noSuchItem)
        assertMapped(FsClient.FsError.leader(message: "exists", code: "EEXIST"), is: .filenameCollision)
        assertMapped(
            FsClient.FsError.leader(message: "not empty", code: "ENOTEMPTY"), is: .directoryNotEmpty)
        assertMapped(
            FsClient.FsError.unexpectedPayload(expected: "file", got: "void"), is: .cannotSynchronize)
        assertMapped(FsClient.FsError.malformedChunking("bad"), is: .cannotSynchronize)
        assertMapped(NSError(domain: "test", code: 1), is: .serverUnreachable)
    }

    func testCanonicalPathRejectsNulAndDropsDotSegments() throws {
        XCTAssertThrowsError(try VFSItemIdentity.canonicalPath("/a\u{0}b"))
        XCTAssertEqual(try VFSItemIdentity.canonicalPath("/a/./b/"), "/a/b")
        XCTAssertEqual(try VFSItemIdentity.canonicalPath("/a/b/.."), "/a")
        XCTAssertThrowsError(try VFSItemIdentity.childPath(parent: "/", name: "."))
        XCTAssertThrowsError(try VFSItemIdentity.childPath(parent: "/", name: "name\u{0}"))
    }
}
