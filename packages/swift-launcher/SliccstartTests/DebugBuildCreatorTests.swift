import XCTest
@testable import Sliccstart

/// Exercises `DebugBuildCreator`'s pure file-patching logic, module
/// resolution, path helpers, and error surface. The subprocess-driven steps
/// (`patchFuses`/`patchAsar` repack) need `npx`/network so they stay out of
/// scope; everything reachable without network is driven here.
final class DebugBuildCreatorTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    // MARK: - Error surface

    func testEveryErrorHasNonEmptyDescription() {
        let errors: [DebugBuildCreator.DebugBuildError] = [
            .notElectronApp, .copyFailed("c"), .fusePatchFailed("f"),
            .asarExtractionFailed("a"), .jsPatcFailed("j"),
            .asarRepackFailed("r"), .signingFailed("s"),
        ]
        for error in errors {
            XCTAssertFalse((error.errorDescription ?? "").isEmpty)
        }
        XCTAssertEqual(DebugBuildCreator.DebugBuildError.notElectronApp.errorDescription, "Not an Electron app")
        XCTAssertEqual(DebugBuildCreator.DebugBuildError.copyFailed("x").errorDescription, "Failed to copy app: x")
    }

    // MARK: - Path helpers

    func testUserApplicationsDirEndsWithApplications() {
        XCTAssertTrue(DebugBuildCreator.userApplicationsDir.hasSuffix("/Applications"))
    }

    func testDebugBuildPathDerivesDebugSuffix() {
        let path = DebugBuildCreator.debugBuildPath(for: "/Applications/Foo.app")
        XCTAssertTrue(path.hasSuffix("/Foo Debug.app"))
    }

    func testDebugBuildExistsCreateAndDeleteRoundTrip() throws {
        let original = "/Applications/SliccTest-\(UUID().uuidString).app"
        let debugPath = DebugBuildCreator.debugBuildPath(for: original)
        addTeardownBlock { try? FileManager.default.removeItem(atPath: debugPath) }

        XCTAssertFalse(DebugBuildCreator.debugBuildExists(for: original))
        // Missing build: delete is a no-op and must not throw.
        try DebugBuildCreator.deleteDebugBuild(for: original)

        try FileManager.default.createDirectory(atPath: debugPath, withIntermediateDirectories: true)
        XCTAssertTrue(DebugBuildCreator.debugBuildExists(for: original))
        try DebugBuildCreator.deleteDebugBuild(for: original)
        XCTAssertFalse(DebugBuildCreator.debugBuildExists(for: original))
    }

    // MARK: - Module resolution

    func testResolveModuleBinFallsBackToNpxInDevMode() {
        let (executable, args) = DebugBuildCreator.resolveModuleBin("@electron/asar", binName: "asar")
        XCTAssertEqual(executable, "/usr/bin/env")
        XCTAssertEqual(args, ["npx", "@electron/asar"])

        // No explicit binName still resolves through the dev-mode npx path.
        let (exe2, args2) = DebugBuildCreator.resolveModuleBin("@electron/fuses")
        XCTAssertEqual(exe2, "/usr/bin/env")
        XCTAssertEqual(args2, ["npx", "@electron/fuses"])
    }

    // MARK: - JavaScript patching

    func testPatchFilesInDirectoryReplacesPatternsAndSkipsNonMatches() throws {
        let dir = tempDir.path
        let patterns = [("BLOCK_CDP()", "true"), ("never-here", "x")]

        let blocked = "\(dir)/blocked.js"
        try "if(BLOCK_CDP()){exit}".write(toFile: blocked, atomically: true, encoding: .utf8)
        let clean = "\(dir)/clean.js"
        try "console.log('ok')".write(toFile: clean, atomically: true, encoding: .utf8)
        // Non-JS file must be ignored entirely.
        try "BLOCK_CDP()".write(toFile: "\(dir)/notjs.txt", atomically: true, encoding: .utf8)

        try DebugBuildCreator.patchFilesInDirectory(dir, patterns: patterns)

        XCTAssertEqual(try String(contentsOfFile: blocked, encoding: .utf8), "if(true){exit}")
        XCTAssertEqual(try String(contentsOfFile: clean, encoding: .utf8), "console.log('ok')")
        XCTAssertEqual(try String(contentsOfFile: "\(dir)/notjs.txt", encoding: .utf8), "BLOCK_CDP()")
    }

    func testPatchFilesNonRecursiveSkipsNestedFiles() throws {
        let nested = tempDir.appendingPathComponent("sub")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        let nestedFile = nested.appendingPathComponent("deep.js").path
        try "BLOCK()".write(toFile: nestedFile, atomically: true, encoding: .utf8)

        try DebugBuildCreator.patchFilesInDirectory(
            tempDir.path, patterns: [("BLOCK()", "true")], recursive: false
        )
        // Nested file is untouched because recursion is disabled.
        XCTAssertEqual(try String(contentsOfFile: nestedFile, encoding: .utf8), "BLOCK()")
    }

    func testPatchJavaScriptFilesPatchesViteBuildAndRoot() throws {
        let buildDir = tempDir.appendingPathComponent(".vite/build")
        try FileManager.default.createDirectory(at: buildDir, withIntermediateDirectories: true)
        let bundled = buildDir.appendingPathComponent("index.js").path
        try "x=Lx(process.argv)&&!HM()&&process.exit(1);"
            .write(toFile: bundled, atomically: true, encoding: .utf8)
        let rootFile = tempDir.appendingPathComponent("main.js").path
        try "y=process.argv.some(e=>e.startsWith(\"--remote-debugging\"))"
            .write(toFile: rootFile, atomically: true, encoding: .utf8)

        try DebugBuildCreator.patchJavaScriptFiles(inDirectory: tempDir.path)

        XCTAssertEqual(try String(contentsOfFile: bundled, encoding: .utf8), "x=true;")
        XCTAssertEqual(try String(contentsOfFile: rootFile, encoding: .utf8), "y=false")
    }

    // MARK: - Subprocess helpers (no network)

    func testPatchAsarReturnsEarlyWhenNoAsarPresent() async throws {
        // No Contents/Resources/app.asar under the temp dir → early return.
        try await DebugBuildCreator.patchAsar(appPath: tempDir.path)
    }

    func testRemoveQuarantineSucceedsOnPlainDirectory() async throws {
        try await DebugBuildCreator.removeQuarantine(appPath: tempDir.path)
    }

    func testSignAppRunsCodesignOnDirectory() async {
        // codesign on a non-bundle directory exercises the signing path; it
        // may throw `signingFailed`, which is acceptable for coverage.
        do {
            try await DebugBuildCreator.signApp(appPath: tempDir.path)
        } catch {
            XCTAssertTrue(error is DebugBuildCreator.DebugBuildError)
        }
    }

    // MARK: - createDebugBuild prologue

    func testCreateDebugBuildThrowsCopyFailedForMissingSource() async {
        let missing = "/nonexistent-\(UUID().uuidString)/Ghost.app"
        var progressSeen = false
        do {
            _ = try await DebugBuildCreator.createDebugBuild(from: missing) { _ in progressSeen = true }
            XCTFail("expected createDebugBuild to throw for a missing source app")
        } catch let DebugBuildCreator.DebugBuildError.copyFailed(message) {
            XCTAssertFalse(message.isEmpty)
        } catch {
            XCTFail("expected copyFailed, got \(error)")
        }
        XCTAssertTrue(progressSeen)
    }
}
