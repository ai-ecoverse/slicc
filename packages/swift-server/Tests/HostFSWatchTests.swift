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
}
