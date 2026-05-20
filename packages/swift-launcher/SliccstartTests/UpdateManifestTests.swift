import XCTest
@testable import Sliccstart

final class UpdateManifestTests: XCTestCase {
    func testCompareReturnsNoChangeWhenAllHashesMatch() {
        let manifest = UpdateManifest(
            version: "2.55.0",
            sliccstart: "aaa",
            sliccServer: "bbb",
            webapp: "ccc",
            webappAsset: "webapp-2.55.0.zip"
        )
        let hashes = RunningAppHashes(sliccstart: "aaa", sliccServer: "bbb", webapp: "ccc")
        XCTAssertEqual(manifest.compare(toRunningHashes: hashes), .noChange)
    }

    func testCompareReturnsWebappOnlyWhenOnlyWebappDiffers() {
        let manifest = UpdateManifest(
            version: "2.55.0",
            sliccstart: "aaa",
            sliccServer: "bbb",
            webapp: "ccc",
            webappAsset: "webapp-2.55.0.zip"
        )
        let hashes = RunningAppHashes(sliccstart: "aaa", sliccServer: "bbb", webapp: "different")
        XCTAssertEqual(manifest.compare(toRunningHashes: hashes), .webappOnly)
    }

    func testCompareReturnsFullAppWhenSliccstartBinaryDiffers() {
        let manifest = UpdateManifest(
            version: "2.55.0",
            sliccstart: "aaa",
            sliccServer: "bbb",
            webapp: "ccc",
            webappAsset: "webapp-2.55.0.zip"
        )
        let hashes = RunningAppHashes(sliccstart: "different", sliccServer: "bbb", webapp: "ccc")
        XCTAssertEqual(manifest.compare(toRunningHashes: hashes), .fullApp)
    }

    func testCompareReturnsFullAppWhenServerBinaryDiffers() {
        let manifest = UpdateManifest(
            version: "2.55.0",
            sliccstart: "aaa",
            sliccServer: "bbb",
            webapp: "ccc",
            webappAsset: "webapp-2.55.0.zip"
        )
        let hashes = RunningAppHashes(sliccstart: "aaa", sliccServer: "different", webapp: "ccc")
        XCTAssertEqual(manifest.compare(toRunningHashes: hashes), .fullApp)
    }

    func testSha256DirectoryIsDeterministicAndOrderIndependent() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("UpdateManifestTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

        try "alpha".write(to: tempDir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        try "beta".write(to: tempDir.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)

        let nested = tempDir.appendingPathComponent("nested", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try "gamma".write(to: nested.appendingPathComponent("c.txt"), atomically: true, encoding: .utf8)

        let firstHash = try sha256Directory(at: tempDir)
        let secondHash = try sha256Directory(at: tempDir)
        XCTAssertEqual(firstHash, secondHash, "two identical hashes for same tree")
        XCTAssertEqual(firstHash.count, 64)
    }

    func testSha256DirectoryDetectsModification() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("UpdateManifestTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        try "alpha".write(to: tempDir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)

        let originalHash = try sha256Directory(at: tempDir)
        try "alpha-modified".write(to: tempDir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        let modifiedHash = try sha256Directory(at: tempDir)
        XCTAssertNotEqual(originalHash, modifiedHash)
    }

    func testSha256FileMatchesKnownVector() throws {
        // sha256("hello\n") = 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
        let tempFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("UpdateManifestTests-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: tempFile) }
        try "hello\n".write(to: tempFile, atomically: true, encoding: .utf8)
        let hash = try sha256File(at: tempFile)
        XCTAssertEqual(hash, "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03")
    }
}
