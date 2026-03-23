import Foundation
import XCTest
@testable import slicc_server

final class ElectronLauncherTests: XCTestCase {
    func testResolveAppPathUsesBundleExecutableNameWhenPresent() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("Sample.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)

        let executableURL = macOSDirectory.appendingPathComponent("Sample")
        FileManager.default.createFile(atPath: executableURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

        let launcher = ElectronLauncher()
        XCTAssertEqual(try launcher.resolveAppPath(bundleURL.path), executableURL.path)
    }

    func testResolveAppPathFallsBackToElectronExecutable() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("Slack.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)

        let helperURL = macOSDirectory.appendingPathComponent("Slack Helper")
        FileManager.default.createFile(atPath: helperURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helperURL.path)

        let executableURL = macOSDirectory.appendingPathComponent("Electron")
        FileManager.default.createFile(atPath: executableURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

        let launcher = ElectronLauncher()
        XCTAssertEqual(try launcher.resolveAppPath(bundleURL.path), executableURL.path)
    }

    func testSelectBestOverlayTargetsKeepsBestTargetPerOrigin() {
        let targets = [
            ElectronInspectableTarget(
                type: "page",
                title: "Microsoft Teams",
                url: "https://teams.example/#deepLink=default&isMinimized=false",
                webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/1"
            ),
            ElectronInspectableTarget(
                type: "page",
                title: "Calendar | Adobe | Microsoft Teams",
                url: "https://teams.example/calendar",
                webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/2"
            ),
            ElectronInspectableTarget(
                type: "page",
                title: "Standalone",
                url: "file:///tmp/index.html",
                webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/3"
            )
        ]

        XCTAssertEqual(
            selectBestOverlayTargets(targets).map(\.webSocketDebuggerURL),
            [
                "ws://127.0.0.1:9223/devtools/page/2",
                "ws://127.0.0.1:9223/devtools/page/3"
            ]
        )
    }

    private func makeTempDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}