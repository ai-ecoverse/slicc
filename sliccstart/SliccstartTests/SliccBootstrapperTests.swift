import XCTest
@testable import Sliccstart

final class SliccBootstrapperTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempDir {
            try? FileManager.default.removeItem(at: tempDir)
        }
    }

    func testFindServerBinaryPrefersBundledBinary() throws {
        let resourcePath = tempDir.appendingPathComponent("Resources")
        let bundledBinary = resourcePath.appendingPathComponent("slicc-server")
        try createFile(at: bundledBinary)

        XCTAssertEqual(
            SliccBootstrapper.findServerBinary(sliccDir: "/unused", resourcePath: resourcePath.path),
            bundledBinary.path
        )
    }

    func testFindServerBinaryFindsRepoLocalDebugBuild() throws {
        let sliccDir = tempDir.appendingPathComponent("slicc")
        let binary = sliccDir.appendingPathComponent("sliccserver/.build/debug/slicc-server")
        try createFile(at: binary)

        XCTAssertEqual(
            SliccBootstrapper.findServerBinary(sliccDir: sliccDir.path, resourcePath: nil),
            binary.path
        )
    }

    func testFindServerBinaryFindsSiblingDebugBuild() throws {
        let workspaceRoot = tempDir.appendingPathComponent("workspace")
        let sliccDir = workspaceRoot.appendingPathComponent("slicc")
        let binary = workspaceRoot.appendingPathComponent("sliccserver/.build/debug/slicc-server")
        try FileManager.default.createDirectory(at: sliccDir, withIntermediateDirectories: true)
        try createFile(at: binary)

        XCTAssertEqual(
            SliccBootstrapper.findServerBinary(sliccDir: sliccDir.path, resourcePath: nil),
            binary.path
        )
    }

    func testCheckInstallationUsesLegacyNodeFallbackWhenServerIsMissing() throws {
        let sliccDir = tempDir.appendingPathComponent("slicc")
        try createFile(at: sliccDir.appendingPathComponent("package.json"))
        try createFile(at: sliccDir.appendingPathComponent("dist/cli/index.js"))

        XCTAssertEqual(
            SliccBootstrapper.checkInstallation(sliccDir: sliccDir.path, resourcePath: nil),
            .installed
        )
    }

    func testResolveLaunchConfigurationPrefersSwiftServer() throws {
        let sliccDir = tempDir.appendingPathComponent("slicc")
        let binary = sliccDir.appendingPathComponent("sliccserver/.build/debug/slicc-server")
        try createFile(at: binary)

        let config = try SliccProcess.resolveLaunchConfiguration(
            sliccDir: sliccDir.path,
            extraArgs: ["--electron-app=/Applications/Test.app", "--kill", "--cdp-port=9223"],
            resourcePath: nil,
            nodePath: "/fake/node"
        )

        XCTAssertEqual(config.executablePath, binary.path)
        XCTAssertEqual(config.arguments, ["--electron-app=/Applications/Test.app", "--kill", "--cdp-port=9223"])
        XCTAssertEqual(config.logLabel, "server")
    }

    func testResolveLaunchConfigurationFallsBackToLegacyNodeCli() throws {
        let sliccDir = tempDir.appendingPathComponent("slicc")
        let legacyEntry = sliccDir.appendingPathComponent("dist/cli/index.js")
        try createFile(at: legacyEntry)

        let config = try SliccProcess.resolveLaunchConfiguration(
            sliccDir: sliccDir.path,
            extraArgs: ["--cdp-port=9222"],
            resourcePath: nil,
            nodePath: "/fake/node"
        )

        XCTAssertEqual(config.executablePath, "/fake/node")
        XCTAssertEqual(config.arguments, [legacyEntry.path, "--cdp-port=9222"])
        XCTAssertEqual(config.logLabel, "node")
    }

    private func createFile(at url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data().write(to: url)
    }
}