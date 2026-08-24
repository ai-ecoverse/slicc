import Logging
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
            "--join-url", "https://join.example/session",
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--lead-worker-base-url", "https://worker.example",
                "--join-url", "https://join.example/session",
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
            "--join", "https://tray.example.com/base/join/tray-123.secret",
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--electron", "--electron-app", "/Applications/Slack.app",
                "--join", "https://tray.example.com/base/join/tray-123.secret",
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
                "--join=https://tray.example.com/base/join/tray-123.secret",
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
            "--join", "https://tray.example.com/base/join/tray-123.secret",
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--join", "https://tray.example.com/base/join/tray-123.secret",
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
            "--join", "https://tray.example.com/base/join/tray-123.secret",
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--lead-worker-base-url", "https://worker.example",
                "--join", "https://tray.example.com/base/join/tray-123.secret",
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

    // A `--lead` run with no worker base URL must fail with a message that
    // names a spelling this binary can actually parse. `--lead` is a `@Flag`
    // here (node-server's `runtime-flags.ts` also accepts `--lead <url>` /
    // `--lead=<url>`; swift-server does not), so advertising those forms sends
    // the reader into an "Unexpected argument" dead end. Guard both halves:
    // the message must not name them, and whatever it DOES name must parse.
    func testLeadWithoutWorkerBaseURLSuggestsOnlyParsableForms() throws {
        let parsed = try ServerCommand.parseAsRoot(["--lead"])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(from: command, arguments: ["slicc-server", "--lead"])

        XCTAssertThrowsError(
            try ServerCommand.resolveBrowserLaunchURL(
                serveOrigin: "http://localhost:5710",
                config: config,
                environment: [:]
            )
        ) { error in
            let message = String(describing: error)
            XCTAssertTrue(
                message.contains("--lead-worker-base-url"),
                "error must name the flag that actually carries the URL, got: \(message)"
            )
            XCTAssertTrue(
                message.contains("WORKER_BASE_URL"),
                "error must keep the env-var escape hatch, got: \(message)"
            )
            XCTAssertFalse(
                message.contains("--lead <url>") || message.contains("--lead=<url>"),
                "error must not suggest forms this binary rejects, got: \(message)"
            )
        }
    }

    // The form the error recommends has to survive the parser — otherwise the
    // message is just a different dead end.
    func testLeadWorkerBaseURLFormFromTheErrorMessageParses() throws {
        let parsed = try ServerCommand.parseAsRoot([
            "--lead", "--lead-worker-base-url", "https://worker.example",
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server", "--lead", "--lead-worker-base-url", "https://worker.example",
            ]
        )

        XCTAssertTrue(config.lead)
        XCTAssertEqual(config.leadWorkerBaseURL?.absoluteString, "https://worker.example")
        XCTAssertNoThrow(
            try ServerCommand.resolveBrowserLaunchURL(
                serveOrigin: "http://localhost:5710",
                config: config,
                environment: [:]
            )
        )
    }

    // The env-var escape hatch the message names must work on its own, with
    // `--lead` and nothing else on the command line.
    func testLeadResolvesWorkerBaseURLFromEnvironment() throws {
        let parsed = try ServerCommand.parseAsRoot(["--lead"])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(from: command, arguments: ["slicc-server", "--lead"])

        XCTAssertNoThrow(
            try ServerCommand.resolveBrowserLaunchURL(
                serveOrigin: "http://localhost:5710",
                config: config,
                environment: ["WORKER_BASE_URL": "https://worker.example"]
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
            "--lead-worker-base-url", "https://slicc-tray-hub-staging.minivelos.workers.dev/",
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: [
                "slicc-server",
                "--lead-worker-base-url", "https://slicc-tray-hub-staging.minivelos.workers.dev/",
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

    func testIsThinBridgeModeRejectsElectronAndServeOnly() throws {
        let baseConfig = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot([]) as? ServerCommand),
            arguments: ["slicc-server"]
        )
        XCTAssertTrue(ServerCommand.isThinBridgeMode(config: baseConfig))

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
        XCTAssertTrue(
            ServerCommand.isThinElectronMode(
                config: electronConfig,
                environment: ["SLICC_HOSTED_LEADER_ORIGIN": "https://www.sliccy.ai"]
            ))
        // Empty env value is treated as absent (matches resolveHostedLeaderOrigin).
        XCTAssertFalse(
            ServerCommand.isThinElectronMode(
                config: electronConfig,
                environment: ["SLICC_HOSTED_LEADER_ORIGIN": ""]
            ))
        XCTAssertFalse(
            ServerCommand.isThinElectronMode(
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

    func testResolveBridgeTokenReturnsNilOutsideThinModesWithoutForwardedToken() {
        XCTAssertNil(
            ServerCommand.resolveBridgeToken(
                thinBridgeMode: false,
                thinElectronMode: false,
                environment: [:]
            ))
    }

    // Regression: a `--serve-only` reattach (neither thin mode active) that
    // carries a forwarded `SLICC_BRIDGE_TOKEN` must honor it so the gate stays
    // enforced and CORS mounts after a full-app-update binary swap. Mirrors
    // node-server's `resolveServerBridgeToken`, which checks the env first.
    func testResolveBridgeTokenHonorsForwardedTokenOutsideThinModes() {
        let token = ServerCommand.resolveBridgeToken(
            thinBridgeMode: false,
            thinElectronMode: false,
            environment: ["SLICC_BRIDGE_TOKEN": "launcher-serve-only-abc"]
        )
        XCTAssertEqual(token, "launcher-serve-only-abc")
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

    // Regression for BUG-F4: the thin-bridge CORS middleware must be mounted
    // whenever a per-process bridge token is present, even with `thinBridgeMode`
    // false (the thin-Electron overlay and `--serve-only` reattach both load
    // cross-origin from the hosted leader, so their `/api/*` fetches need
    // `access-control-*` headers). Mirrors node-server's
    // `shouldMountThinBridgeCors(thinBridgeMode, bridgeToken)`.
    func testShouldMountThinBridgeCorsSelectedWhenTokenPresentOutsideThinBridge() {
        XCTAssertTrue(
            ServerCommand.shouldMountThinBridgeCors(
                thinBridgeMode: false,
                bridgeToken: "tok"
            ))
    }

    func testShouldMountThinBridgeCorsSelectedUnderThinBridgeMode() {
        XCTAssertTrue(
            ServerCommand.shouldMountThinBridgeCors(
                thinBridgeMode: true,
                bridgeToken: nil
            ))
    }

    func testNormalizeTrayWorkerBaseURLStripsEverythingButTheOrigin() {
        // The value ends up in URLs the webapp dials, so a stray trailing
        // slash or a leftover query would produce a double-slashed endpoint.
        XCTAssertEqual(
            ServerCommand.normalizeTrayWorkerBaseURL(" https://tray.example.com/base/?a=1#f "),
            "https://tray.example.com/base"
        )
        XCTAssertEqual(ServerCommand.normalizeTrayWorkerBaseURL("https://tray.example.com/"), "https://tray.example.com")
        XCTAssertEqual(ServerCommand.normalizeTrayWorkerBaseURL("https://tray.example.com///"), "https://tray.example.com")
        XCTAssertNil(ServerCommand.normalizeTrayWorkerBaseURL("   "))
        XCTAssertNil(ServerCommand.normalizeTrayWorkerBaseURL("tray.example.com"))
        XCTAssertNil(ServerCommand.normalizeTrayWorkerBaseURL(nil))
    }

    func testParseEnvFileSecretsReadsTheSameSyntaxAsTheKeychainBlob() throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("slicc-env-\(UUID().uuidString).env")
        try """
        GITHUB_TOKEN=ghp_test
        GITHUB_TOKEN_DOMAINS=api.github.com
        """.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let secrets = try XCTUnwrap(ServerCommand.parseEnvFileSecrets(at: url))

        XCTAssertEqual(secrets.map(\.name), ["GITHUB_TOKEN"])
        XCTAssertEqual(secrets.first?.domains, ["api.github.com"])
        // A missing file is "no override", not an empty secret set.
        XCTAssertNil(ServerCommand.parseEnvFileSecrets(at: url.appendingPathExtension("gone")))
    }

    func testLoggerLevelMapsTheCliVocabularyOntoSwiftLog() {
        XCTAssertEqual(ServerCommand.loggerLevel(from: "debug"), .debug)
        // The CLI says "warn", swift-log says "warning".
        XCTAssertEqual(ServerCommand.loggerLevel(from: "warn"), .warning)
        XCTAssertEqual(ServerCommand.loggerLevel(from: "error"), .error)
        XCTAssertEqual(ServerCommand.loggerLevel(from: "info"), .info)
        XCTAssertEqual(ServerCommand.loggerLevel(from: "verbose"), .info)
    }

    func testShouldMountThinBridgeCorsOffInLegacyModesWithoutToken() {
        // Dev / serve-only without a forwarded token: no token ⇒ no root
        // middleware mounted (swift-server never serves UI; API/CDP bridge only).
        XCTAssertFalse(
            ServerCommand.shouldMountThinBridgeCors(
                thinBridgeMode: false,
                bridgeToken: nil
            ))
    }

    func testParsesRepeatableMountMappingsIntoANormalizedMountTable() throws {
        let parsed = try ServerCommand.parseAsRoot([
            "--mount", "/Users/me/proj/:/mnt/project/", "--mount=/Users/me/docs:/mnt/docs",
            "--mount", "/Users/me/other:/mnt/project",
            "--mount", "relative:/mnt/x", "--mount", "/mnt/one-sided", "--mount", " ",
        ])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(from: command, arguments: ["slicc-server"])
        XCTAssertEqual(
            config.mounts,
            [
                ServerConfig.MountMapping(hostPath: "/Users/me/proj", path: "/mnt/project"),
                ServerConfig.MountMapping(hostPath: "/Users/me/docs", path: "/mnt/docs"),
            ])
    }

    func testMountMappingParsingRules() throws {
        let parsed = try ServerCommand.parseAsRoot([])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(from: command, arguments: ["slicc-server"])
        XCTAssertEqual(config.mounts, [])
        // Last-colon split keeps OS paths containing ':' intact.
        XCTAssertEqual(
            ServerConfig.parseMountMapping("/we:ird/dir:/mnt/x"),
            ServerConfig.MountMapping(hostPath: "/we:ird/dir", path: "/mnt/x"))
        // Tilde expansion against the provided home.
        XCTAssertEqual(
            ServerConfig.parseMountMapping("~/proj:/mnt/p", homeDirectory: "/Users/me"),
            ServerConfig.MountMapping(hostPath: "/Users/me/proj", path: "/mnt/p"))
        XCTAssertNil(ServerConfig.parseMountMapping("~/proj:/mnt/p", homeDirectory: ""))
        // Root target, relative sides, and one-sided values are rejected.
        XCTAssertNil(ServerConfig.parseMountMapping("/a:/"))
        XCTAssertNil(ServerConfig.parseMountMapping("rel:/mnt/x"))
        XCTAssertNil(ServerConfig.parseMountMapping("/a:rel"))
        XCTAssertNil(ServerConfig.parseMountMapping("/mnt/only-target"))
    }
}
