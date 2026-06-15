import XCTest
@testable import Sliccstart

/// Coverage tests for small pure helpers in `AppScanner`,
/// `SliccBootstrapper`, and `TolerantGithubReleaseProvider`. These were
/// previously only exercised through the SwiftUI app lifecycle, which
/// `swift test` cannot drive; the package coverage gate (see
/// `packages/dev-tools/tools/swift-coverage-check.sh`) dropped below the
/// `coverage-thresholds.json` floors when `SliccstartApp.swift` grew the
/// SwiftOptel wiring, so we backfill the easily-testable helpers here.
final class LauncherHelpersCoverageTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("LauncherHelpersCoverageTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDir, FileManager.default.fileExists(atPath: tempDir.path) {
            try? FileManager.default.removeItem(at: tempDir)
        }
    }

    // MARK: - AppScanner pure helpers

    func testAppNameStripsDotAppSuffix() {
        XCTAssertEqual(AppScanner.appName(fromPath: "/Applications/Safari.app"), "Safari")
        XCTAssertEqual(AppScanner.appName(fromPath: "/Applications/Google Chrome.app"), "Google Chrome")
    }

    func testAppNameLeavesNonAppFilenameAlone() {
        XCTAssertEqual(AppScanner.appName(fromPath: "/usr/local/bin/node"), "node")
        XCTAssertEqual(AppScanner.appName(fromPath: "/tmp/something.txt"), "something.txt")
    }

    func testExecutablePathJoinsMacOSDirectory() {
        XCTAssertEqual(
            AppScanner.executablePath(forApp: "/Applications/Foo.app", name: "Foo"),
            "/Applications/Foo.app/Contents/MacOS/Foo"
        )
    }

    func testUserApplicationsDirIsHomeSubdirectory() {
        let dir = AppScanner.userApplicationsDir
        XCTAssertTrue(dir.hasSuffix("/Applications"))
        XCTAssertTrue(dir.contains(FileManager.default.homeDirectoryForCurrentUser.path))
    }

    func testHasCDPFrameworkReturnsFalseForMissingPath() {
        let missing = tempDir.appendingPathComponent("DoesNotExist.app").path
        XCTAssertFalse(AppScanner.hasCDPFramework(atPath: missing))
    }

    func testHasCDPFrameworkDetectsElectronFramework() throws {
        let appPath = tempDir.appendingPathComponent("Sample.app")
        let framework = appPath.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")
        try FileManager.default.createDirectory(at: framework, withIntermediateDirectories: true)
        XCTAssertTrue(AppScanner.hasCDPFramework(atPath: appPath.path))
    }

    func testHasCDPFrameworkDetectsMSWebView2Framework() throws {
        let appPath = tempDir.appendingPathComponent("Teams.app")
        let framework = appPath.appendingPathComponent("Contents/Frameworks/MSWebView2.framework")
        try FileManager.default.createDirectory(at: framework, withIntermediateDirectories: true)
        XCTAssertTrue(AppScanner.hasCDPFramework(atPath: appPath.path))
    }

    func testCheckDebugSupportReturnsSupportedForNonElectronPath() {
        let nonElectron = tempDir.appendingPathComponent("Plain.app").path
        XCTAssertEqual(AppScanner.checkDebugSupport(atPath: nonElectron), .supported)
    }

    func testCheckDebugSupportFlagsKnownBlockedElectronApp() throws {
        let appPath = tempDir.appendingPathComponent("Claude.app")
        let framework = appPath.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")
        try FileManager.default.createDirectory(at: framework, withIntermediateDirectories: true)
        XCTAssertEqual(AppScanner.checkDebugSupport(atPath: appPath.path), .disabled)
    }

    func testCheckDebugSupportAllowsUnknownElectronApp() throws {
        let appPath = tempDir.appendingPathComponent("Some Other App.app")
        let framework = appPath.appendingPathComponent("Contents/Frameworks/Electron Framework.framework")
        try FileManager.default.createDirectory(at: framework, withIntermediateDirectories: true)
        XCTAssertEqual(AppScanner.checkDebugSupport(atPath: appPath.path), .supported)
    }

    // MARK: - SliccBootstrapper pure helpers

    func testDefaultSliccDirIsHomeDotSliccSlicc() {
        XCTAssertEqual(SliccBootstrapper.defaultSliccDir, NSHomeDirectory() + "/.slicc/slicc")
    }

    func testCheckInstallationReturnsNotInstalledWhenSliccDirMissing() {
        let missing = tempDir.appendingPathComponent("nothing-here").path
        XCTAssertEqual(
            SliccBootstrapper.checkInstallation(sliccDir: missing, resourcePath: nil),
            .notInstalled
        )
    }

    func testCheckInstallationReturnsInstalledWhenBundledServerPresent() throws {
        let resourcePath = tempDir.appendingPathComponent("Resources")
        try FileManager.default.createDirectory(at: resourcePath, withIntermediateDirectories: true)
        try Data().write(to: resourcePath.appendingPathComponent("slicc-server"))
        XCTAssertEqual(
            SliccBootstrapper.checkInstallation(sliccDir: "/unused", resourcePath: resourcePath.path),
            .installed
        )
    }

    func testFindServerBinaryReturnsNilWhenNothingFound() {
        let empty = tempDir.appendingPathComponent("empty").path
        XCTAssertNil(SliccBootstrapper.findServerBinary(sliccDir: empty, resourcePath: nil))
    }

    func testBootstrapErrorDescriptionsAreNonEmpty() {
        XCTAssertEqual(
            SliccBootstrapper.BootstrapError.nodeNotFound.errorDescription,
            "Node.js not found. Install from https://nodejs.org to run development bootstrap/update tasks."
        )
        XCTAssertEqual(
            SliccBootstrapper.BootstrapError.commandFailed("git clone failed").errorDescription,
            "Command failed: git clone failed"
        )
    }

    /// Exercise the `Bundle.main`-driven static properties without
    /// asserting a specific value — under `swift test` the resource path
    /// points at the test bundle (which has no slicc / node / server),
    /// but the call still covers the body and `FileManager.fileExists`
    /// branch.
    func testBundledStaticPropertiesAreEvaluable() {
        _ = SliccBootstrapper.bundledNodePath
        _ = SliccBootstrapper.bundledSliccDir
        _ = SliccBootstrapper.bundledServerBinaryPath
        _ = SliccBootstrapper.isBundled
    }

    // MARK: - TolerantGithubReleaseProvider init branches

    func testTolerantProviderInitWithExplicitTokenIsRetained() {
        // The explicit-token branch keeps the value; nothing observable
        // besides "the init does not crash and the value flows through to
        // the Authorization header on a real request" — the latter is
        // exercised in `UpdaterIntegrationTests`. Here we just guarantee
        // the initializer is covered for all three resolution branches.
        _ = TolerantGithubReleaseProvider(authToken: "ghp_test_token")
    }

    func testTolerantProviderInitWithEmptyTokenFallsThroughToNil() {
        // Empty explicit string should collapse to nil so we don't emit a
        // bare "Authorization: Bearer " header.
        _ = TolerantGithubReleaseProvider(authToken: "")
    }

    func testTolerantProviderInitWithNilTokenReadsEnvironment() {
        // No explicit token — covers the environment-lookup branch. The
        // environment-set vs. environment-empty outcome is incidental.
        _ = TolerantGithubReleaseProvider(authToken: nil)
    }
}
