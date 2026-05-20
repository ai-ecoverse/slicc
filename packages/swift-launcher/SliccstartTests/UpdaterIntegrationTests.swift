import XCTest
@testable import Sliccstart

/// Integration test for the updater. Unlike `EndToEndUpdateTests` (which
/// exercises the modules in-process), this suite launches the **real
/// shipping `Sliccstart` binary** as a subprocess against a loopback
/// `FakeUpdateServer`. It catches regressions in the wiring layer that
/// only manifest end-to-end: missing argv parsing, missing exit code,
/// SwiftUI accidentally being started before the probe, etc.
@MainActor
final class UpdaterIntegrationTests: XCTestCase {

    /// Detect-only mode: with running hashes that match the manifest,
    /// the probe should report `noUpdate` and the server should see
    /// exactly one releases listing + one manifest fetch.
    func testProbeReportsNoUpdate_WhenAllHashesMatch() throws {
        let fixtures = try makeFixtures(version: "9.9.9")
        defer { fixtures.tearDown() }

        let overlayRoot = makeTempDirectory()
        let output = try runProbe(
            arguments: [
                "--probe-update",
                "--update-host=\(fixtures.server.baseURL.absoluteString)",
                "--overlay-root=\(overlayRoot.path)",
                "--owner=\(fixtures.owner)",
                "--repo=\(fixtures.repo)",
                "--release-prefix=Sliccstart",
                "--running-sliccstart-hash=\(fixtures.manifest.sliccstart)",
                "--running-server-hash=\(fixtures.manifest.sliccServer)",
                "--running-webapp-hash=\(fixtures.manifest.webapp)",
                "--mode=detect",
            ]
        )
        XCTAssertEqual(output.exitCode, 0, "stderr: \(output.stderr) stdout: \(output.stdout)")
        let json = try parseJSON(output.stdout)
        XCTAssertEqual(json["state"] as? String, "noUpdate")
        XCTAssertEqual(json["respawnCount"] as? Int, 0)

        let paths = fixtures.server.recordedRequestsSnapshot().map(\.path)
        XCTAssertEqual(paths.filter { $0.hasPrefix("/repos/") }.count, 1)
        XCTAssertEqual(paths.filter { $0.contains("manifest-9.9.9.json") }.count, 1)
        XCTAssertEqual(paths.filter { $0.contains("webapp-9.9.9.zip") }.count, 0)
    }

    /// Full-update path: when the running slicc-server hash differs,
    /// the probe should report `fullUpdateRequired` and never touch the
    /// webapp asset.
    func testProbeReportsFullUpdateRequired_WhenBinariesDiffer() throws {
        let fixtures = try makeFixtures(version: "9.9.9")
        defer { fixtures.tearDown() }

        let overlayRoot = makeTempDirectory()
        let output = try runProbe(
            arguments: [
                "--probe-update",
                "--update-host=\(fixtures.server.baseURL.absoluteString)",
                "--overlay-root=\(overlayRoot.path)",
                "--running-sliccstart-hash=\(fixtures.manifest.sliccstart)",
                "--running-server-hash=different-from-manifest",
                "--running-webapp-hash=\(fixtures.manifest.webapp)",
                "--mode=apply",
            ]
        )
        XCTAssertEqual(output.exitCode, 0, "stderr: \(output.stderr) stdout: \(output.stdout)")
        let json = try parseJSON(output.stdout)
        XCTAssertEqual(json["state"] as? String, "fullUpdateRequired")
        XCTAssertEqual(json["version"] as? String, "9.9.9")

        let paths = fixtures.server.recordedRequestsSnapshot().map(\.path)
        XCTAssertEqual(paths.filter { $0.contains("webapp-") }.count, 0,
                       "must not download webapp on the full-update path")
    }

    /// The full happy path: launch the real binary, drive
    /// detect → apply → activate. Asserts on the JSON output, on the
    /// fact that the overlay directory now exists with the expected
    /// contents, and on the request count seen by the fake server.
    func testProbeAppliesWebappOnlyUpdate_EndToEnd() throws {
        let webappFiles = [
            "index.html": "<html>integration fixture</html>",
            "assets/main.js": "console.log('integration');",
        ]
        let fixtures = try makeFixtures(version: "9.9.9", webappContents: webappFiles)
        defer { fixtures.tearDown() }

        let overlayRoot = makeTempDirectory()
        let output = try runProbe(
            arguments: [
                "--probe-update",
                "--update-host=\(fixtures.server.baseURL.absoluteString)",
                "--overlay-root=\(overlayRoot.path)",
                "--running-sliccstart-hash=\(fixtures.manifest.sliccstart)",
                "--running-server-hash=\(fixtures.manifest.sliccServer)",
                "--running-webapp-hash=stale-webapp-hash",
                "--mode=apply",
            ]
        )
        XCTAssertEqual(output.exitCode, 0, "stderr: \(output.stderr) stdout: \(output.stdout)")
        let json = try parseJSON(output.stdout)

        XCTAssertEqual(json["state"] as? String, "applied")
        XCTAssertEqual(json["version"] as? String, "9.9.9")
        XCTAssertEqual(json["activeOverlayVersion"] as? String, "9.9.9")
        XCTAssertEqual(json["respawnCount"] as? Int, 1,
                       "respawn callback must fire exactly once")
        guard let overlayPath = json["overlayPath"] as? String else {
            return XCTFail("missing overlayPath in probe output")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: overlayPath),
                      "active overlay directory must exist on disk")
        let indexURL = URL(fileURLWithPath: overlayPath).appendingPathComponent("index.html")
        let assetURL = URL(fileURLWithPath: overlayPath).appendingPathComponent("assets/main.js")
        XCTAssertEqual(try String(contentsOf: indexURL), webappFiles["index.html"])
        XCTAssertEqual(try String(contentsOf: assetURL), webappFiles["assets/main.js"])

        // The fake server should have seen exactly the three calls the
        // production code path makes: releases listing, manifest fetch,
        // webapp zip download. Any extra request would indicate a retry
        // or duplicate code path slipping in.
        let paths = fixtures.server.recordedRequestsSnapshot().map(\.path)
        XCTAssertEqual(paths.filter { $0.hasPrefix("/repos/") }.count, 1)
        XCTAssertEqual(paths.filter { $0.contains("manifest-9.9.9.json") }.count, 1)
        XCTAssertEqual(paths.filter { $0.contains("webapp-9.9.9.zip") }.count, 1)
    }

    /// Tampered download: if the served zip's sha256 doesn't match the
    /// manifest, the probe must report `failed` with a non-zero respawn
    /// count of 0 and leave the overlay deactivated.
    func testProbeRefusesTamperedWebappDownload() throws {
        let fixtures = try makeFixtures(version: "9.9.9")
        defer { fixtures.tearDown() }

        // Replace the zip bytes with garbage. Manifest hash unchanged →
        // the coordinator should refuse to activate.
        fixtures.setWebappAssetBytes(Data("not a real zip".utf8))

        let overlayRoot = makeTempDirectory()
        let output = try runProbe(
            arguments: [
                "--probe-update",
                "--update-host=\(fixtures.server.baseURL.absoluteString)",
                "--overlay-root=\(overlayRoot.path)",
                "--running-sliccstart-hash=\(fixtures.manifest.sliccstart)",
                "--running-server-hash=\(fixtures.manifest.sliccServer)",
                "--running-webapp-hash=stale",
                "--mode=apply",
            ]
        )
        XCTAssertEqual(output.exitCode, 0, "stderr: \(output.stderr) stdout: \(output.stdout)")
        let json = try parseJSON(output.stdout)
        XCTAssertEqual(json["state"] as? String, "failed")
        XCTAssertEqual(json["respawnCount"] as? Int, 0,
                       "respawn must not fire when the download is rejected")
        XCTAssertNil(json["activeOverlayVersion"], "no overlay must be activated on failure")
    }

    // MARK: - Helpers

    private struct ProbeOutput {
        let stdout: String
        let stderr: String
        let exitCode: Int32
    }

    /// Run the *built* `Sliccstart` binary with the given arguments and
    /// capture both stdout and stderr. The binary is located via the
    /// xctest bundle URL, which sits inside the SPM build products dir
    /// alongside the executable.
    private func runProbe(arguments: [String]) throws -> ProbeOutput {
        let binaryURL = try locateSliccstartBinary()
        let process = Process()
        process.executableURL = binaryURL
        process.arguments = arguments

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        try process.run()

        // Wait for completion with a generous safety timeout so a hung
        // probe surfaces as a test failure instead of a CI deadlock.
        let deadline = Date().addingTimeInterval(30)
        while process.isRunning {
            if Date() > deadline {
                process.terminate()
                // SIGTERM may be ignored by a wedged probe; escalate to
                // SIGKILL after a brief grace period so the subsequent
                // `readDataToEndOfFile()` reads close to EOF instead of
                // blocking forever and deadlocking CI.
                let killBy = Date().addingTimeInterval(1.0)
                while process.isRunning && Date() < killBy {
                    Thread.sleep(forTimeInterval: 0.05)
                }
                if process.isRunning {
                    kill(process.processIdentifier, SIGKILL)
                }
                XCTFail("probe binary hung; killed at deadline")
                break
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        // Make sure the OS has finished reaping the process and closed
        // the pipe FDs before we ask for data — otherwise the read can
        // block on a dangling write end.
        process.waitUntilExit()

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        return ProbeOutput(
            stdout: String(data: stdoutData, encoding: .utf8) ?? "",
            stderr: String(data: stderrData, encoding: .utf8) ?? "",
            exitCode: process.terminationStatus
        )
    }

    private func locateSliccstartBinary() throws -> URL {
        // Allow CI / scripts to point at an explicit binary.
        if let override = ProcessInfo.processInfo.environment["SLICCSTART_TEST_BIN"] {
            return URL(fileURLWithPath: override)
        }

        // `Bundle(for: type(of: self))` returns the xctest bundle. Its
        // parent directory is `.build/<triple>/<config>/`, which also
        // contains the built `Sliccstart` executable.
        let bundleURL = Bundle(for: type(of: self)).bundleURL
        let buildDir = bundleURL.deletingLastPathComponent()
        let candidate = buildDir.appendingPathComponent("Sliccstart")
        if FileManager.default.fileExists(atPath: candidate.path) {
            return candidate
        }

        // Fallback: walk upward looking for `Sliccstart` in any
        // sibling `.build/.../debug` or `.../release` directory. Covers
        // unusual swift-pm layouts.
        var search = bundleURL.deletingLastPathComponent()
        for _ in 0..<5 {
            let probe = search.appendingPathComponent("Sliccstart")
            if FileManager.default.fileExists(atPath: probe.path) {
                return probe
            }
            search = search.deletingLastPathComponent()
        }
        throw NSError(
            domain: "UpdaterIntegrationTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Sliccstart binary not found near \(buildDir.path)"]
        )
    }

    private func parseJSON(_ text: String) throws -> [String: Any] {
        // The probe writes one JSON line; ignore anything else that
        // might land on stdout (Logger output, etc.).
        let line = text.split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)
            .reversed()
            .first(where: { $0.hasPrefix("{") }) ?? text
        let data = Data(line.utf8)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    private func makeTempDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("UpdaterIntegrationTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func makeFixtures(
        version: String,
        webappContents: [String: String] = ["index.html": "<html>integration</html>"]
    ) throws -> UpdateTestFixtures {
        try UpdateTestFixtures.make(version: version, webappContents: webappContents)
    }
}
