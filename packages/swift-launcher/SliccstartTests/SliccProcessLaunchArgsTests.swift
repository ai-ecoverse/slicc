import XCTest
@testable import Sliccstart

/// Pins the leader/follower CLI flags Sliccstart hands to slicc-server.
/// The exact flag strings are the contract between the launcher and
/// `swift-server`'s `ServerCommand`, so a typo here would silently break
/// auto-attach without any obvious crash signal.
final class SliccProcessLaunchArgsTests: XCTestCase {

    // MARK: - Browser launch args

    func testStandaloneBrowserArgsAlwaysIncludeLeadFlag() {
        let args = SliccProcess.standaloneBrowserArgs(cdpPort: 9222, overlay: nil)
        XCTAssertEqual(args, ["--cdp-port=9222", "--lead"])
    }

    func testStandaloneBrowserArgsAppendStaticRootOverlay() {
        let args = SliccProcess.standaloneBrowserArgs(
            cdpPort: 9222,
            overlay: "/tmp/overlay"
        )
        XCTAssertEqual(args, ["--cdp-port=9222", "--lead", "--static-root=/tmp/overlay"])
    }

    func testStandaloneBrowserArgsIgnoreEmptyOverlay() {
        let args = SliccProcess.standaloneBrowserArgs(cdpPort: 9222, overlay: "")
        XCTAssertEqual(args, ["--cdp-port=9222", "--lead"])
    }

    // MARK: - Browser launch env

    func testStandaloneBrowserEnvDefaultsWorkerBaseUrl() {
        let env = SliccProcess.standaloneBrowserEnv(
            executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
            servePort: 5710,
            inheritedEnv: [:]
        )
        XCTAssertEqual(env["WORKER_BASE_URL"], SliccProcess.defaultWorkerBaseUrl)
        XCTAssertEqual(env["PORT"], "5710")
        XCTAssertEqual(env["CHROME_PATH"], "/Applications/Chromium.app/Contents/MacOS/Chromium")
    }

    func testStandaloneBrowserEnvPreservesUserWorkerBaseUrl() {
        let env = SliccProcess.standaloneBrowserEnv(
            executablePath: "/x",
            servePort: 5710,
            inheritedEnv: ["WORKER_BASE_URL": "https://example.test"]
        )
        XCTAssertEqual(env["WORKER_BASE_URL"], "https://example.test")
    }

    func testStandaloneBrowserEnvTreatsEmptyInheritedAsAbsent() {
        let env = SliccProcess.standaloneBrowserEnv(
            executablePath: "/x",
            servePort: 5710,
            inheritedEnv: ["WORKER_BASE_URL": ""]
        )
        XCTAssertEqual(env["WORKER_BASE_URL"], SliccProcess.defaultWorkerBaseUrl)
    }

    // MARK: - Electron follower args

    func testElectronAppArgsOmitJoinWhenNoLeaderJoinUrl() {
        let args = SliccProcess.electronAppArgs(
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: nil,
            overlay: nil
        )
        XCTAssertEqual(args, [
            "--electron-app=/Applications/Slack.app",
            "--kill",
            "--cdp-port=9223",
        ])
    }

    func testElectronAppArgsThreadJoinUrlWhenLeaderAvailable() {
        let args = SliccProcess.electronAppArgs(
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: "https://example.test/join/abc.def",
            overlay: nil
        )
        XCTAssertEqual(args, [
            "--electron-app=/Applications/Slack.app",
            "--kill",
            "--cdp-port=9223",
            "--join=https://example.test/join/abc.def",
        ])
    }

    func testElectronAppArgsTreatEmptyJoinUrlAsAbsent() {
        let args = SliccProcess.electronAppArgs(
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: "",
            overlay: nil
        )
        XCTAssertFalse(args.contains { $0.hasPrefix("--join=") })
    }

    func testElectronAppArgsAppendStaticRootAfterJoin() {
        let args = SliccProcess.electronAppArgs(
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: "https://example.test/join/abc.def",
            overlay: "/tmp/overlay"
        )
        XCTAssertEqual(args.last, "--static-root=/tmp/overlay")
        XCTAssertTrue(args.contains("--join=https://example.test/join/abc.def"))
    }
}
