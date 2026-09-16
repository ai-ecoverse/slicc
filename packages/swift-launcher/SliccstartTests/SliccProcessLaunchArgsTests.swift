import XCTest

@testable import Sliccstart

final class SliccProcessLaunchArgsTests: XCTestCase {

    func testStandaloneBrowserArgsAlwaysIncludeLeadFlag() {
        let args = SliccProcess.standaloneBrowserArgs(cdpPort: 9222)
        XCTAssertEqual(args, ["--cdp-port=9222", "--lead"])
    }

    func testStandaloneBrowserArgsAppendOneMountFlagPerTableEntry() {
        let args = SliccProcess.standaloneBrowserArgs(
            cdpPort: 9222,
            mounts: [
                .init(hostPath: "/h/a", path: "/mnt/a"), .init(hostPath: "/h/b", path: "/mnt/b"),
            ])
        XCTAssertEqual(
            args, ["--cdp-port=9222", "--lead", "--mount=/h/a:/mnt/a", "--mount=/h/b:/mnt/b"])
    }

    func testReattachArgsCarryTheMountTableForBrowsersOnly() {
        let browser = SliccProcess.reattachArgs(
            targetType: .chromiumBrowser, electronAppPath: nil, cdpPort: 9222, joinUrl: nil,
            mounts: [.init(hostPath: "/h/a", path: "/mnt/a")])
        XCTAssertEqual(browser, ["--serve-only", "--cdp-port=9222", "--mount=/h/a:/mnt/a"])
        let electron = SliccProcess.reattachArgs(
            targetType: .electronApp, electronAppPath: "/Apps/X.app", cdpPort: 9223, joinUrl: nil,
            mounts: [.init(hostPath: "/h/a", path: "/mnt/a")])
        XCTAssertFalse(electron.contains("--mount=/h/a:/mnt/a"))
    }

    func testBrowserFollowerArgsJoinInsteadOfLead() {
        let args = SliccProcess.browserFollowerArgs(
            cdpPort: 9222,
            joinUrl: "https://example.test/join/abc.def"
        )
        XCTAssertEqual(args, ["--cdp-port=9222", "--join=https://example.test/join/abc.def"])
        XCTAssertFalse(args.contains("--lead"))
    }

    func testStandaloneBrowserEnvDefaultsWorkerBaseUrl() {
        let env = SliccProcess.standaloneBrowserEnv(
            executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
            servePort: 5710,
            inheritedEnv: [:]
        )
        XCTAssertEqual(env["WORKER_BASE_URL"], SliccProcess.defaultWorkerBaseUrl)
        XCTAssertEqual(env["PORT"], "5710")
        XCTAssertEqual(env["CHROME_PATH"], "/Applications/Chromium.app/Contents/MacOS/Chromium")
        XCTAssertEqual(env["SLICC_BRIDGE_TOKEN"], SliccProcess.standaloneBridgeToken)
    }

    func testStandaloneBrowserEnvForwardsExplicitBridgeToken() {
        let env = SliccProcess.standaloneBrowserEnv(
            executablePath: "/x",
            servePort: 5710,
            inheritedEnv: [:],
            bridgeToken: "standalone-token-xyz"
        )
        XCTAssertEqual(env["SLICC_BRIDGE_TOKEN"], "standalone-token-xyz")
    }

    func testStandaloneBridgeTokenIsStableAndNonEmpty() {

        XCTAssertEqual(SliccProcess.standaloneBridgeToken, SliccProcess.standaloneBridgeToken)
        XCTAssertFalse(SliccProcess.standaloneBridgeToken.isEmpty)
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

    func testElectronAppArgsOmitJoinWhenNoLeaderJoinUrl() {
        let args = SliccProcess.electronAppArgs(
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: nil
        )
        XCTAssertEqual(
            args,
            [
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
        XCTAssertEqual(
            args,
            [
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

    func testSpawnLogArgumentsRedactJoinAndTokenValues() {
        let arguments = [
            "--electron-app=/Applications/Slack.app",
            "--join=https://example.test/join/secret.value",
            "--bridge-token=bridge-secret",
            "--token",
            "separate-secret",
            "--cdp-port=9223",
        ]

        let redacted = SliccProcess.redactedSpawnArguments(arguments)

        XCTAssertEqual(
            redacted,
            [
                "--electron-app=/Applications/Slack.app",
                "--join=<redacted>",
                "--bridge-token=<redacted>",
                "--token",
                "<redacted>",
                "--cdp-port=9223",
            ])
        XCTAssertFalse(redacted.joined(separator: " ").contains("secret"))
    }

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

        let args = SliccProcess.reattachArgs(
            targetType: .electronApp,
            electronAppPath: "/Applications/Slack.app",
            cdpPort: 9223,
            joinUrl: "https://example.test/join/abc.def"
        )
        XCTAssertEqual(
            args,
            [
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
        XCTAssertEqual(
            args,
            [
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

        XCTAssertEqual(SliccProcess.thinElectronBridgeToken, SliccProcess.thinElectronBridgeToken)
        XCTAssertFalse(SliccProcess.thinElectronBridgeToken.isEmpty)
    }

    func testThinElectronEnvDefaultsToLauncherMintedToken() {
        let env = SliccProcess.thinElectronEnv(inheritedEnv: [:])
        XCTAssertEqual(env["SLICC_BRIDGE_TOKEN"], SliccProcess.thinElectronBridgeToken)
        XCTAssertEqual(env["SLICC_HOSTED_LEADER_ORIGIN"], SliccProcess.defaultHostedLeaderOrigin)
    }
}
