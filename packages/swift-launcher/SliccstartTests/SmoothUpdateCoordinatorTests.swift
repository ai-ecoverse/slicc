import XCTest
@testable import Sliccstart

@MainActor
final class SmoothUpdateCoordinatorTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("SmoothUpdateCoordinatorTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDir, FileManager.default.fileExists(atPath: tempDir.path) {
            try? FileManager.default.removeItem(at: tempDir)
        }
        try super.tearDownWithError()
    }

    func testEvaluateSetsWebappOnlyWhenBinariesMatch() {
        let manifest = UpdateManifest(
            version: "2.55.0",
            sliccstart: "aaa",
            sliccServer: "bbb",
            webapp: "new-ccc",
            webappAsset: "webapp-2.55.0.zip"
        )
        let coordinator = SmoothUpdateCoordinator(
            hashesProvider: { RunningAppHashes(sliccstart: "aaa", sliccServer: "bbb", webapp: "old-ccc") }
        )
        let assetURL = URL(string: "https://example.com/webapp-2.55.0.zip")!
        coordinator.evaluate(manifest: manifest, webappAssetURL: assetURL)
        XCTAssertEqual(
            coordinator.state,
            .webappOnlyAvailable(version: "2.55.0", assetURL: assetURL, hash: "new-ccc")
        )
    }

    func testEvaluateSetsFullUpdateWhenServerBinaryDiffers() {
        let manifest = UpdateManifest(
            version: "2.55.0",
            sliccstart: "aaa",
            sliccServer: "new-bbb",
            webapp: "ccc",
            webappAsset: "webapp-2.55.0.zip"
        )
        let coordinator = SmoothUpdateCoordinator(
            hashesProvider: { RunningAppHashes(sliccstart: "aaa", sliccServer: "old-bbb", webapp: "ccc") }
        )
        coordinator.evaluate(manifest: manifest, webappAssetURL: URL(string: "https://example.com/x")!)
        XCTAssertEqual(coordinator.state, .fullUpdateRequired(version: "2.55.0"))
    }

    func testEvaluateSetsNoUpdateWhenEverythingMatches() {
        let manifest = UpdateManifest(
            version: "2.55.0",
            sliccstart: "aaa",
            sliccServer: "bbb",
            webapp: "ccc",
            webappAsset: "webapp-2.55.0.zip"
        )
        let coordinator = SmoothUpdateCoordinator(
            hashesProvider: { RunningAppHashes(sliccstart: "aaa", sliccServer: "bbb", webapp: "ccc") }
        )
        coordinator.evaluate(manifest: manifest, webappAssetURL: URL(string: "https://example.com/x")!)
        XCTAssertEqual(coordinator.state, .noUpdate)
    }

    func testApplyWebappOnlyFlipsActivePointerAndCallsRespawn() async throws {
        // Build a fake "webapp" directory and zip it so the coordinator
        // sees a real .zip + real overlay extraction.
        let staging = tempDir.appendingPathComponent("staging", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try "<html>v2</html>".write(
            to: staging.appendingPathComponent("index.html"),
            atomically: true,
            encoding: .utf8
        )
        let stagedZipURL = tempDir.appendingPathComponent("webapp-staged.zip")
        try ditto(contentsOf: staging, to: stagedZipURL)

        let overlayRoot = tempDir.appendingPathComponent("overlay-root", isDirectory: true)
        let overlayStore = WebappOverlayStore(rootDirectory: overlayRoot)

        var respawnCount = 0
        let coordinator = SmoothUpdateCoordinator(
            assetDownloader: { _, destination in
                try FileManager.default.copyItem(at: stagedZipURL, to: destination)
            },
            overlayStore: overlayStore,
            hashesProvider: { RunningAppHashes(sliccstart: "a", sliccServer: "b", webapp: "c") }
        )

        // Compute the actual hash of the unpacked directory so the
        // coordinator's verification step passes.
        let expectedDir = tempDir.appendingPathComponent("for-hash", isDirectory: true)
        try FileManager.default.createDirectory(at: expectedDir, withIntermediateDirectories: true)
        try "<html>v2</html>".write(
            to: expectedDir.appendingPathComponent("index.html"),
            atomically: true,
            encoding: .utf8
        )
        let expectedHash = try sha256Directory(at: expectedDir)

        await coordinator.applyWebappOnly(
            version: "2.55.0",
            assetURL: URL(string: "https://example.com/webapp-2.55.0.zip")!,
            manifestWebappHash: expectedHash,
            respawn: { respawnCount += 1 }
        )

        XCTAssertEqual(coordinator.state, .applied(version: "2.55.0"))
        XCTAssertEqual(respawnCount, 1)
        XCTAssertEqual(overlayStore.activeVersion(), "2.55.0")
        XCTAssertNotNil(overlayStore.activeOverlayPath())
    }

    func testApplyWebappOnlyRejectsHashMismatch() async throws {
        let staging = tempDir.appendingPathComponent("staging", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try "tampered".write(
            to: staging.appendingPathComponent("index.html"),
            atomically: true,
            encoding: .utf8
        )
        let stagedZipURL = tempDir.appendingPathComponent("webapp-bad.zip")
        try ditto(contentsOf: staging, to: stagedZipURL)

        let overlayRoot = tempDir.appendingPathComponent("overlay-root", isDirectory: true)
        let overlayStore = WebappOverlayStore(rootDirectory: overlayRoot)

        var respawnCount = 0
        let coordinator = SmoothUpdateCoordinator(
            assetDownloader: { _, destination in
                try FileManager.default.copyItem(at: stagedZipURL, to: destination)
            },
            overlayStore: overlayStore,
            hashesProvider: { RunningAppHashes(sliccstart: "a", sliccServer: "b", webapp: "c") }
        )

        await coordinator.applyWebappOnly(
            version: "2.55.0",
            assetURL: URL(string: "https://example.com/webapp.zip")!,
            manifestWebappHash: String(repeating: "f", count: 64),
            respawn: { respawnCount += 1 }
        )

        if case .failed = coordinator.state {
            // expected
        } else {
            XCTFail("expected .failed for hash mismatch, got \(coordinator.state)")
        }
        XCTAssertEqual(respawnCount, 0, "respawn must NOT run when hash check fails")
        XCTAssertNil(overlayStore.activeVersion(), "active pointer must NOT be flipped on mismatch")
    }

    private func ditto(contentsOf sourceDir: URL, to destinationZip: URL) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        task.arguments = ["-c", "-k", sourceDir.path, destinationZip.path]
        try task.run()
        task.waitUntilExit()
        XCTAssertEqual(task.terminationStatus, 0, "ditto failed")
    }
}
