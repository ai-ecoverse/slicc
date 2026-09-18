import Foundation
import XCTest

@testable import slicc_server

final class HostFSWatchTests: XCTestCase {
    func testToMountRelativePath() {
        XCTAssertEqual(
            HostFSWatch.toMountRelativePath(root: "/Users/me/kb", absolutePath: "/Users/me/kb/notes.md"),
            "notes.md"
        )
        XCTAssertEqual(
            HostFSWatch.toMountRelativePath(root: "/Users/me/kb", absolutePath: "/Users/me/kb"),
            ""
        )
        XCTAssertEqual(
            HostFSWatch.toMountRelativePath(root: "/Users/me/kb", absolutePath: "/Users/other/x"),
            ""
        )
    }

    func testBuildEventClearsOnOverflowOrEmptyPath() {
        let normal = HostFSWatch.buildEvent(mount: "/mnt/kb", paths: ["a.txt", "b.txt"])
        XCTAssertEqual(normal["type"]?.stringValue, "hostfs_invalidate")
        XCTAssertEqual(normal["mount"]?.stringValue, "/mnt/kb")
        if case .array(let paths)? = normal["paths"] {
            XCTAssertEqual(Set(paths.compactMap(\.stringValue)), Set(["a.txt", "b.txt"]))
        } else {
            XCTFail("expected paths array")
        }

        let cleared = HostFSWatch.buildEvent(mount: "/mnt/kb", paths: ["", "a.txt"])
        if case .array(let paths)? = cleared["paths"] {
            XCTAssertTrue(paths.isEmpty)
        } else {
            XCTFail("expected empty paths")
        }
    }

    func testDebouncedNotesBroadcastOneInvalidationAndStopCancelsPendingWork() async throws {
        let system = LickSystem()
        let messages = HostWatchMessageBox()
        await system.addClient(WebSocketClient { messages.add($0) })
        let watch = HostFSWatch(lickSystem: system)

        watch.noteForTesting(mount: "/mnt/project", root: "/tmp/root", absolutePath: "/tmp/root/a.txt")
        watch.noteForTesting(mount: "/mnt/project", root: "/tmp/root", absolutePath: "/tmp/root/b.txt")
        try await waitUntil("debounced hostfs invalidation") { !messages.snapshot().isEmpty }
        let payload = try LickSystem.decode(try XCTUnwrap(messages.snapshot().first))
        XCTAssertEqual(payload["mount"], .string("/mnt/project"))
        guard case .array(let paths)? = payload["paths"] else { return XCTFail("missing paths") }
        XCTAssertEqual(Set(paths.compactMap(\.stringValue)), Set(["a.txt", "b.txt"]))

        watch.noteForTesting(mount: "/mnt/project", root: "/tmp/root", absolutePath: "/tmp/root/c.txt")
        watch.stop()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(messages.snapshot().count, 1)
        await system.shutdown()
    }

    func testLiveFileSystemEventBroadcastsAnInvalidation() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("slicc-hostfs-watch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let system = LickSystem()
        let messages = HostWatchMessageBox()
        await system.addClient(WebSocketClient { messages.add($0) })
        let watch = HostFSWatch(lickSystem: system)
        watch.start(roots: [.init(path: "/mnt/live", root: root.path)])
        defer { watch.stop() }

        try Data("changed".utf8).write(to: root.appendingPathComponent("event.txt"))
        try await waitUntil(
            "live hostfs invalidation",
            timeoutMilliseconds: 5_000
        ) { !messages.snapshot().isEmpty }

        let payload = try LickSystem.decode(try XCTUnwrap(messages.snapshot().last))
        XCTAssertEqual(payload["mount"], .string("/mnt/live"))
        await system.shutdown()
    }
}

private final class HostWatchMessageBox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func add(_ value: String) { lock.withLock { values.append(value) } }
    func snapshot() -> [String] { lock.withLock { values } }
}
