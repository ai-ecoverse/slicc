import XCTest
@testable import Sliccstart

final class WebappOverlayStoreTests: XCTestCase {
    private var tempDir: URL!
    private var store: WebappOverlayStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("WebappOverlayStoreTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        store = WebappOverlayStore(rootDirectory: tempDir)
    }

    override func tearDownWithError() throws {
        if let tempDir, FileManager.default.fileExists(atPath: tempDir.path) {
            try? FileManager.default.removeItem(at: tempDir)
        }
        try super.tearDownWithError()
    }

    func testActiveOverlayPathIsNilWhenNothingInstalled() {
        XCTAssertNil(store.activeOverlayPath())
        XCTAssertNil(store.activeVersion())
    }

    func testSetActiveAndReadBack() throws {
        let overlayDir = tempDir.appendingPathComponent("2.55.0", isDirectory: true)
        try FileManager.default.createDirectory(at: overlayDir, withIntermediateDirectories: true)
        try store.setActive(version: "2.55.0")
        XCTAssertEqual(store.activeVersion(), "2.55.0")
        XCTAssertEqual(store.activeOverlayPath(), overlayDir.path)
    }

    func testActiveOverlayPathReturnsNilWhenPointedDirectoryMissing() throws {
        try store.setActive(version: "9.9.9")
        XCTAssertNil(store.activeOverlayPath(), "missing overlay directory must not be reported as active")
    }

    func testInstallExtractsZipIntoVersionedDirectory() throws {
        let staging = tempDir.appendingPathComponent("staging", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try "hello".write(
            to: staging.appendingPathComponent("a.txt"),
            atomically: true,
            encoding: .utf8
        )
        let zipURL = tempDir.appendingPathComponent("source.zip")
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        task.arguments = ["-c", "-k", staging.path, zipURL.path]
        try task.run()
        task.waitUntilExit()
        XCTAssertEqual(task.terminationStatus, 0)

        let overlayDir = try store.install(zipURL: zipURL, version: "2.55.0")
        XCTAssertTrue(FileManager.default.fileExists(atPath: overlayDir.appendingPathComponent("a.txt").path))
    }

    /// Regression test for the zip-slip hardening added during PR
    /// review: `install()` must refuse any archive containing a path
    /// that would write outside the destination directory.
    func testInstallRejectsZipWithParentTraversal() throws {
        let zipURL = try makeZipWithEntry(name: "../escape.txt", body: "pwned")
        XCTAssertThrowsError(try store.install(zipURL: zipURL, version: "9.9.9")) { error in
            assertUnsafeEntry(error, expectedReasonContains: "traversal")
        }
        let escapedPath = tempDir.appendingPathComponent("escape.txt").path
        XCTAssertFalse(FileManager.default.fileExists(atPath: escapedPath),
                       "no file may land outside the overlay directory on a rejected install")
    }

    func testValidateArchiveEntriesRejectsAbsolutePath() throws {
        let zipURL = try makeZipWithEntry(name: "/etc/passwd-mock", body: "x")
        XCTAssertThrowsError(try store.validateArchiveEntries(zipURL: zipURL)) { error in
            assertUnsafeEntry(error, expectedReasonContains: "absolute path")
        }
    }

    func testValidateArchiveEntriesRejectsBackslashSeparator() throws {
        let zipURL = try makeZipWithEntry(name: "a\\b.txt", body: "x")
        XCTAssertThrowsError(try store.validateArchiveEntries(zipURL: zipURL)) { error in
            assertUnsafeEntry(error, expectedReasonContains: "backslash")
        }
    }

    private func assertUnsafeEntry(_ error: Error, expectedReasonContains: String) {
        if let overlayError = error as? WebappOverlayStore.OverlayError,
           case .unsafeEntry(_, let reason) = overlayError {
            XCTAssertTrue(reason.contains(expectedReasonContains),
                          "expected reason to contain \(expectedReasonContains), got '\(reason)'")
        } else {
            XCTFail("expected OverlayError.unsafeEntry, got \(error)")
        }
    }

    /// Build a zip whose central directory contains a single entry with
    /// the literal path `name`. We use python3 because the macOS `zip`
    /// CLI normalizes traversal paths and strips leading slashes —
    /// exactly the bypass our validator needs to defend against.
    private func makeZipWithEntry(name: String, body: String) throws -> URL {
        let zipURL = tempDir.appendingPathComponent("\(UUID().uuidString).zip")
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        let script = """
        import zipfile, sys
        z = zipfile.ZipFile(sys.argv[1], 'w')
        z.writestr(sys.argv[2], sys.argv[3])
        z.close()
        """
        task.arguments = ["python3", "-c", script, zipURL.path, name, body]
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw XCTSkip("python3 unavailable; cannot build malicious zip fixture")
        }
        return zipURL
    }

    func testPruneOthersKeepsOnlyTheNamedOverlay() throws {
        let oldDir = tempDir.appendingPathComponent("2.50.0", isDirectory: true)
        let newDir = tempDir.appendingPathComponent("2.55.0", isDirectory: true)
        let newZip = tempDir.appendingPathComponent("2.55.0.zip")
        try FileManager.default.createDirectory(at: oldDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: newDir, withIntermediateDirectories: true)
        try "zip-content".write(to: newZip, atomically: true, encoding: .utf8)
        try store.setActive(version: "2.55.0")

        store.pruneOthers(keep: "2.55.0")
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldDir.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: newDir.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: newZip.path), "kept version's zip must survive")
    }
}
