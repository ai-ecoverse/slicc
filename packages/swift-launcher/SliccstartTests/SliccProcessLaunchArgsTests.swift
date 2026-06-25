import XCTest
@testable import Sliccstart

/// Pins the leader/follower CLI flags Sliccstart hands to slicc-server.
/// The exact flag strings are the contract between the launcher and
/// `swift-server`'s `ServerCommand`, so a typo here would silently break
/// auto-attach without any obvious crash signal.
final class SliccProcessLaunchArgsTests: XCTestCase {

    // MARK: - Browser launch args

    func testStandaloneBrowserArgsAlwaysIncludeLeadFlag() {
        let args = SliccProcess.standaloneBrowserArgs(cdpPort: 9222)
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
            joinUrl: nil
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
            joinUrl: "https://example.test/join/abc.def"
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
            joinUrl: ""
        )
        XCTAssertFalse(args.contains { $0.hasPrefix("--join=") })
    }

    // MARK: - Reattach args (smooth-update respawn path)

    func testReattachArgsChromiumBrowserOmitsJoinAndElectronFlags() {
        let args = SliccProcess.reattachArgs(
            targetType: .chromiumBrowser,
            electronAppPath: nil,
            cdpPort: 9222,
            joinUrl: nil
        )
        XCTAssertEqual(args, ["--serve-only", "--cdp-port=9222"])
    }

    func testReattachArgsElectronWithJoinUrlIncludesJoinFlag() {
        // The P2 regression Codex flagged: reattach into a surviving
        // Electron follower must re-thread `--join=<url>` so the
        // follower keeps auto-attaching to the leader.
        let args = SliccProcess.reattachArgs(
            targetType: .electronApp,
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: "https://example.test/join/abc.def"
        )
        XCTAssertEqual(args, [
            "--serve-only",
            "--cdp-port=9223",
            "--electron-app=/Applications/Slack.app",
            "--electron",
            "--join=https://example.test/join/abc.def",
        ])
    }

    func testReattachArgsElectronWithoutJoinUrlOmitsJoinFlag() {
        let args = SliccProcess.reattachArgs(
            targetType: .electronApp,
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: nil
        )
        XCTAssertEqual(args, [
            "--serve-only",
            "--cdp-port=9223",
            "--electron-app=/Applications/Slack.app",
            "--electron",
        ])
        XCTAssertFalse(args.contains { $0.hasPrefix("--join=") })
    }

    func testReattachArgsElectronTreatsEmptyJoinUrlAsAbsent() {
        let args = SliccProcess.reattachArgs(
            targetType: .electronApp,
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: ""
        )
        XCTAssertFalse(args.contains { $0.hasPrefix("--join=") })
    }

    // MARK: - Thin-Electron env (forwarded to slicc-server `--electron` child)

    func testResolveHostedLeaderOriginDefaultsToProductionWhenEnvAbsent() {
        XCTAssertEqual(
            SliccProcess.resolveHostedLeaderOrigin(inheritedEnv: [:]),
            SliccProcess.defaultHostedLeaderOrigin
        )
    }

    func testResolveHostedLeaderOriginPrefersExplicitOverride() {
        XCTAssertEqual(
            SliccProcess.resolveHostedLeaderOrigin(
                inheritedEnv: ["SLICC_HOSTED_LEADER_ORIGIN": "https://staging.example.test"]
            ),
            "https://staging.example.test"
        )
    }

    func testResolveHostedLeaderOriginFallsBackToWorkerBaseUrl() {
        XCTAssertEqual(
            SliccProcess.resolveHostedLeaderOrigin(
                inheritedEnv: ["WORKER_BASE_URL": "https://worker.example.test"]
            ),
            "https://worker.example.test"
        )
    }

    func testResolveHostedLeaderOriginStripsTrailingSlashes() {
        XCTAssertEqual(
            SliccProcess.resolveHostedLeaderOrigin(
                inheritedEnv: ["SLICC_HOSTED_LEADER_ORIGIN": "https://staging.example.test///"]
            ),
            "https://staging.example.test"
        )
    }

    func testResolveHostedLeaderOriginTreatsEmptyOverrideAsAbsent() {
        XCTAssertEqual(
            SliccProcess.resolveHostedLeaderOrigin(
                inheritedEnv: ["SLICC_HOSTED_LEADER_ORIGIN": "", "WORKER_BASE_URL": ""]
            ),
            SliccProcess.defaultHostedLeaderOrigin
        )
    }

    func testThinElectronEnvCarriesHostedOriginAndBridgeToken() {
        let env = SliccProcess.thinElectronEnv(
            inheritedEnv: ["SLICC_HOSTED_LEADER_ORIGIN": "https://staging.example.test"],
            bridgeToken: "launcher-token-xyz"
        )
        XCTAssertEqual(env["SLICC_HOSTED_LEADER_ORIGIN"], "https://staging.example.test")
        XCTAssertEqual(env["SLICC_BRIDGE_TOKEN"], "launcher-token-xyz")
    }

    func testThinElectronBridgeTokenIsStableAcrossCalls() {
        // The launcher-wide token must be the SAME across every reattach +
        // launchWithElectronApp call so the spawned slicc-server child's
        // gate sees the same secret it was launched with. A per-call mint
        // would silently break reattach after a smooth update.
        XCTAssertEqual(SliccProcess.thinElectronBridgeToken, SliccProcess.thinElectronBridgeToken)
        XCTAssertFalse(SliccProcess.thinElectronBridgeToken.isEmpty)
    }

    func testThinElectronEnvDefaultsToLauncherMintedToken() {
        let env = SliccProcess.thinElectronEnv(inheritedEnv: [:])
        XCTAssertEqual(env["SLICC_BRIDGE_TOKEN"], SliccProcess.thinElectronBridgeToken)
        XCTAssertEqual(env["SLICC_HOSTED_LEADER_ORIGIN"], SliccProcess.defaultHostedLeaderOrigin)
    }
}
