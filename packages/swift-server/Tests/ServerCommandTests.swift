import XCTest
@testable import slicc_server

final class ServerCommandTests: XCTestCase {
    func testElectronDefaultsToElectronAttachPort() throws {
        let parsed = try ServerCommand.parseAsRoot(["--electron"])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: ["slicc-server", "--electron"]
        )

        XCTAssertTrue(config.electron)
        XCTAssertEqual(config.cdpPort, ServerConfig.defaultElectronAttachCdpPort)
        XCTAssertFalse(config.explicitCdpPort)
    }

    func testExplicitCdpPortWinsInElectronMode() throws {
        let parsed = try ServerCommand.parseAsRoot(["--electron", "--cdp-port", "9222"])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: ["slicc-server", "--electron", "--cdp-port", "9222"]
        )

        XCTAssertEqual(config.cdpPort, 9222)
        XCTAssertTrue(config.explicitCdpPort)
    }

    func testElectronAppEnablesElectronAndResolvesPath() throws {
        let parsed = try ServerCommand.parseAsRoot(["--electron-app", "~/Apps/Test.app"])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: ["slicc-server", "--electron-app", "~/Apps/Test.app"]
        )

        XCTAssertTrue(config.electron)
        XCTAssertEqual(config.electronApp, "~/Apps/Test.app")
        XCTAssertEqual(
            config.electronAppURL?.path(percentEncoded: false),
            NSString(string: "~/Apps/Test.app").expandingTildeInPath
        )
    }

    func testInvalidLogLevelFallsBackToInfo() throws {
        let parsed = try ServerCommand.parseAsRoot(["--log-level", "verbose"])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: ["slicc-server", "--log-level", "verbose"]
        )

        XCTAssertEqual(config.logLevel, "info")
    }

    func testLeadAndJoinOptionsImplyModes() throws {
        let parsed = try ServerCommand.parseAsRoot([
            "--lead-worker-base-url", "https://worker.example",
            "--join-url", "https://join.example/session"
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--lead-worker-base-url", "https://worker.example",
                "--join-url", "https://join.example/session"
            ]
        )

        XCTAssertTrue(config.lead)
        XCTAssertEqual(config.leadWorkerBaseURL?.absoluteString, "https://worker.example")
        XCTAssertTrue(config.join)
        XCTAssertEqual(config.joinURL?.absoluteString, "https://join.example/session")
    }

    // Parity with node-server's `runtime-flags.ts`: `slicc-server --join <url>`
    // must parse the URL as the option value and populate `config.joinUrl`,
    // which `/api/runtime-config` surfaces as `trayJoinUrl` for the
    // embedded Electron-overlay follower's auto-attach flow.
    func testJoinFlagParsesUrlAsValue() throws {
        let parsed = try ServerCommand.parseAsRoot([
            "--electron", "--electron-app", "/Applications/Slack.app",
            "--join", "https://tray.example.com/base/join/tray-123.secret"
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--electron", "--electron-app", "/Applications/Slack.app",
                "--join", "https://tray.example.com/base/join/tray-123.secret"
            ]
        )

        XCTAssertTrue(config.electron)
        XCTAssertTrue(config.join)
        XCTAssertEqual(config.joinUrl, "https://tray.example.com/base/join/tray-123.secret")
        XCTAssertEqual(
            config.joinURL?.absoluteString,
            "https://tray.example.com/base/join/tray-123.secret"
        )
    }

    func testJoinFlagEqualsSyntaxParsesUrl() throws {
        let parsed = try ServerCommand.parseAsRoot([
            "--join=https://tray.example.com/base/join/tray-123.secret"
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--join=https://tray.example.com/base/join/tray-123.secret"
            ]
        )

        XCTAssertTrue(config.join)
        XCTAssertEqual(config.joinUrl, "https://tray.example.com/base/join/tray-123.secret")
    }

    // End-to-end parity for the Electron-follower auto-attach launch flow:
    // `slicc-server --electron <app> --join <url>` must (a) parse the join
    // URL into `config.joinUrl` (covered above) and (b) hand the leader's
    // browser a canonical `?tray=<encoded-join-url>` launch URL via
    // `resolveBrowserLaunchURL`. `node-server` performs the equivalent
    // assembly in `resolveCliBrowserLaunchUrl` (see `launch-url.test.ts`).
    func testResolveBrowserLaunchURLBuildsCanonicalTrayUrlForJoinFlow() throws {
        let parsed = try ServerCommand.parseAsRoot([
            "--join", "https://tray.example.com/base/join/tray-123.secret"
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--join", "https://tray.example.com/base/join/tray-123.secret"
            ]
        )

        let launchURL = try ServerCommand.resolveBrowserLaunchURL(
            serveOrigin: "http://localhost:5710",
            config: config,
            environment: [:]
        )

        XCTAssertEqual(
            launchURL,
            "http://localhost:5710?tray=https://tray.example.com/base/join/tray-123.secret"
        )
    }

    // `--lead` and `--join` are mutually exclusive launch flows; the runtime
    // must reject the combination at startup rather than silently picking
    // one and confusing the follower auto-attach contract.
    func testResolveBrowserLaunchURLRejectsLeadAndJoinTogether() throws {
        let parsed = try ServerCommand.parseAsRoot([
            "--lead-worker-base-url", "https://worker.example",
            "--join", "https://tray.example.com/base/join/tray-123.secret"
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--lead-worker-base-url", "https://worker.example",
                "--join", "https://tray.example.com/base/join/tray-123.secret"
            ]
        )

        XCTAssertThrowsError(
            try ServerCommand.resolveBrowserLaunchURL(
                serveOrigin: "http://localhost:5710",
                config: config,
                environment: [:]
            )
        )
    }

    // MARK: - Thin-bridge launch URL parity with node-server Path A

    // Thin-bridge mode appends `bridge=<ws-url>&bridgeToken=<token>` to the
    // hosted-leader launch URL so the same webapp bridge client connects
    // unchanged regardless of which runtime served it. Mirrors
    // `appendBridgeParams` in `packages/node-server/src/launch-url.ts`.
    func testResolveBrowserLaunchURLAppendsBridgeParamsInThinMode() throws {
        let parsed = try ServerCommand.parseAsRoot([])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(from: command, arguments: ["slicc-server"])

        let launchURL = try ServerCommand.resolveBrowserLaunchURL(
            serveOrigin: "http://localhost:5710",
            config: config,
            environment: [:],
            bridgeWsUrl: "ws://localhost:5710/cdp",
            bridgeToken: "tok-abc"
        )

        // The launch URL points at the hosted leader, NOT the local serve origin.
        XCTAssertTrue(launchURL.hasPrefix("https://www.sliccy.ai"))
        XCTAssertTrue(launchURL.contains("bridge=ws://localhost:5710/cdp"))
        XCTAssertTrue(launchURL.contains("bridgeToken=tok-abc"))
    }

    func testResolveBrowserLaunchURLPrefersExplicitLeaderOriginInThinMode() throws {
        let parsed = try ServerCommand.parseAsRoot([
            "--lead-worker-base-url", "https://slicc-tray-hub-staging.minivelos.workers.dev/"
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--lead-worker-base-url", "https://slicc-tray-hub-staging.minivelos.workers.dev/"
            ]
        )

        let launchURL = try ServerCommand.resolveBrowserLaunchURL(
            serveOrigin: "http://localhost:5710",
            config: config,
            environment: [:],
            bridgeWsUrl: "ws://localhost:5710/cdp",
            bridgeToken: "tok-xyz"
        )

        // `--lead` flow composes with the bridge params; tray=... is appended
        // to the staging leader origin.
        XCTAssertTrue(launchURL.hasPrefix("https://slicc-tray-hub-staging.minivelos.workers.dev"))
        XCTAssertTrue(launchURL.contains("tray=https://slicc-tray-hub-staging.minivelos.workers.dev"))
        XCTAssertTrue(launchURL.contains("bridge=ws://localhost:5710/cdp"))
        XCTAssertTrue(launchURL.contains("bridgeToken=tok-xyz"))
    }

    func testResolveBrowserLaunchURLOmitsBridgeParamsWithoutToken() throws {
        let parsed = try ServerCommand.parseAsRoot([])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(from: command, arguments: ["slicc-server"])

        let launchURL = try ServerCommand.resolveBrowserLaunchURL(
            serveOrigin: "http://localhost:5710",
            config: config,
            environment: [:]
        )

        XCTAssertEqual(launchURL, "http://localhost:5710")
        XCTAssertFalse(launchURL.contains("bridge="))
        XCTAssertFalse(launchURL.contains("bridgeToken="))
    }

    func testIsThinBridgeModeRejectsDevElectronAndServeOnly() throws {
        let baseConfig = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot([]) as? ServerCommand),
            arguments: ["slicc-server"]
        )
        XCTAssertTrue(ServerCommand.isThinBridgeMode(config: baseConfig))

        let devConfig = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot(["--dev"]) as? ServerCommand),
            arguments: ["slicc-server", "--dev"]
        )
        XCTAssertFalse(ServerCommand.isThinBridgeMode(config: devConfig))

        let serveOnlyConfig = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot(["--serve-only"]) as? ServerCommand),
            arguments: ["slicc-server", "--serve-only"]
        )
        XCTAssertFalse(ServerCommand.isThinBridgeMode(config: serveOnlyConfig))

        let electronConfig = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot(["--electron"]) as? ServerCommand),
            arguments: ["slicc-server", "--electron"]
        )
        XCTAssertFalse(ServerCommand.isThinBridgeMode(config: electronConfig))
    }

    func testRepositoryRootPrefersBundledSliccDirectory() {
        let root = ServerCommand.repositoryRoot(
            bundlePath: "/Applications/Sliccstart.app",
            resourcePath: "/Applications/Sliccstart.app/Contents/Resources",
            currentDirectoryPath: "/tmp"
        )

        XCTAssertEqual(root.path, "/Applications/Sliccstart.app/Contents/Resources/slicc")
    }

    func testRepositoryRootPrefersCurrentDirectoryWhenStaticAssetsExist() throws {
        let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(
            at: tempDirectory.appendingPathComponent("dist/ui"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let root = ServerCommand.repositoryRoot(
            bundlePath: "/tmp/slicc-server",
            resourcePath: nil,
            currentDirectoryPath: tempDirectory.path
        )

        XCTAssertEqual(root.path, tempDirectory.path)
    }

    func testResolveServePortUsesPortEnvironmentAsPreferredPort() async throws {
        let resolvedPort = try await ServerCommand.resolveServePort(from: ["PORT": "5710"]) { startingFrom, _ in
            XCTAssertEqual(startingFrom, 5710)
            return 5800
        }

        XCTAssertEqual(resolvedPort, 5800)
    }

    func testResolveServePortFallsBackToResolverWhenPortEnvironmentMissing() async throws {
        let resolvedPort = try await ServerCommand.resolveServePort(from: [:]) { startingFrom, _ in
            XCTAssertEqual(startingFrom, ServerCommand.defaultServePort)
            return 5800
        }

        XCTAssertEqual(resolvedPort, 5800)
    }

    func testResolveServePortFallsBackToResolverWhenPortEnvironmentInvalid() async throws {
        let resolvedPort = try await ServerCommand.resolveServePort(from: ["PORT": "70000"]) { startingFrom, _ in
            XCTAssertEqual(startingFrom, ServerCommand.defaultServePort)
            return 5801
        }

        XCTAssertEqual(resolvedPort, 5801)
    }

    func testResolveServePortRequestsStrictModeWhenPortEnvironmentIsExplicit() async throws {
        var observedStrict: Bool?
        let resolvedPort = try await ServerCommand.resolveServePort(from: ["PORT": "5710"]) { startingFrom, strict in
            observedStrict = strict
            XCTAssertEqual(startingFrom, 5710)
            return startingFrom
        }

        XCTAssertEqual(resolvedPort, 5710)
        XCTAssertEqual(observedStrict, true)
    }

    func testResolveServePortKeepsPermissiveModeWhenPortEnvironmentMissing() async throws {
        var observedStrict: Bool?
        let resolvedPort = try await ServerCommand.resolveServePort(from: [:]) { startingFrom, strict in
            observedStrict = strict
            return startingFrom
        }

        XCTAssertEqual(resolvedPort, ServerCommand.defaultServePort)
        XCTAssertEqual(observedStrict, false)
    }

    // MARK: - Thin-Electron mode

    func testIsThinElectronModeRequiresElectronAndHostedOriginEnv() throws {
        let electronConfig = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot(["--electron"]) as? ServerCommand),
            arguments: ["slicc-server", "--electron"]
        )
        // Opt-in active: --electron + non-empty SLICC_HOSTED_LEADER_ORIGIN.
        XCTAssertTrue(ServerCommand.isThinElectronMode(
            config: electronConfig,
            environment: ["SLICC_HOSTED_LEADER_ORIGIN": "https://www.sliccy.ai"]
        ))
        // Empty env value is treated as absent (matches resolveHostedLeaderOrigin).
        XCTAssertFalse(ServerCommand.isThinElectronMode(
            config: electronConfig,
            environment: ["SLICC_HOSTED_LEADER_ORIGIN": ""]
        ))
        XCTAssertFalse(ServerCommand.isThinElectronMode(
            config: electronConfig,
            environment: [:]
        ))
    }

    func testIsThinElectronModeRejectsServeOnlyAndNonElectron() throws {
        let env = ["SLICC_HOSTED_LEADER_ORIGIN": "https://www.sliccy.ai"]
        let serveOnlyElectron = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot(["--electron", "--serve-only"]) as? ServerCommand),
            arguments: ["slicc-server", "--electron", "--serve-only"]
        )
        XCTAssertFalse(ServerCommand.isThinElectronMode(config: serveOnlyElectron, environment: env))

        let baseConfig = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot([]) as? ServerCommand),
            arguments: ["slicc-server"]
        )
        XCTAssertFalse(ServerCommand.isThinElectronMode(config: baseConfig, environment: env))
    }

    func testResolveBridgeTokenReturnsNilOutsideThinModes() {
        XCTAssertNil(ServerCommand.resolveBridgeToken(
            thinBridgeMode: false,
            thinElectronMode: false,
            environment: ["SLICC_BRIDGE_TOKEN": "ignored"]
        ))
    }

    func testResolveBridgeTokenPrefersEnvForwardedToken() {
        let token = ServerCommand.resolveBridgeToken(
            thinBridgeMode: false,
            thinElectronMode: true,
            environment: ["SLICC_BRIDGE_TOKEN": "launcher-minted-abc"]
        )
        XCTAssertEqual(token, "launcher-minted-abc")
    }

    func testResolveBridgeTokenMintsFreshTokenWhenEnvAbsent() {
        let token = ServerCommand.resolveBridgeToken(
            thinBridgeMode: true,
            thinElectronMode: false,
            environment: [:]
        )
        XCTAssertNotNil(token)
        XCTAssertFalse(token?.isEmpty ?? true)
    }

    func testResolveBridgeTokenTreatsEmptyEnvAsAbsent() {
        let token = ServerCommand.resolveBridgeToken(
            thinBridgeMode: false,
            thinElectronMode: true,
            environment: ["SLICC_BRIDGE_TOKEN": ""]
        )
        XCTAssertNotNil(token)
        XCTAssertNotEqual(token, "")
    }

    // MARK: - CORS middleware mount gate (BUG-F4)

    // Regression for BUG-F4: the thin-bridge CORS middleware must be mounted in
    // thin-Electron mode, not just canonical thin-bridge mode. The Electron
    // overlay loads cross-origin from the hosted leader, so its
    // `/api/runtime-config` fetch needs `access-control-*` headers. Mirrors
    // node-server's `shouldMountThinBridgeCors`.
    func testShouldMountThinBridgeCorsSelectedUnderThinElectronMode() {
        XCTAssertTrue(ServerCommand.shouldMountThinBridgeCors(
            thinBridgeMode: false,
            thinElectronMode: true
        ))
    }

    func testShouldMountThinBridgeCorsSelectedUnderThinBridgeMode() {
        XCTAssertTrue(ServerCommand.shouldMountThinBridgeCors(
            thinBridgeMode: true,
            thinElectronMode: false
        ))
    }

    func testShouldMountThinBridgeCorsOffInLegacyModes() {
        // Dev / serve-only: neither mode active ⇒ no root middleware mounted
        // (swift-server never serves UI; API/CDP bridge only).
        XCTAssertFalse(ServerCommand.shouldMountThinBridgeCors(
            thinBridgeMode: false,
            thinElectronMode: false
        ))
    }
}
