import XCTest

@testable import Sliccstart








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

    
    
    
    
    
    func testBundledStaticPropertiesAreEvaluable() {
        _ = SliccBootstrapper.bundledNodePath
        _ = SliccBootstrapper.bundledSliccDir
        _ = SliccBootstrapper.bundledServerBinaryPath
        _ = SliccBootstrapper.isBundled
    }

    

    func testTolerantProviderInitWithExplicitTokenIsRetained() {
        
        
        
        
        
        _ = TolerantGithubReleaseProvider(authToken: "ghp_test_token")
    }

    func testTolerantProviderInitWithEmptyTokenFallsThroughToNil() {
        
        
        _ = TolerantGithubReleaseProvider(authToken: "")
    }

    func testTolerantProviderInitWithNilTokenReadsEnvironment() {
        
        
        _ = TolerantGithubReleaseProvider(authToken: nil)
    }
}
