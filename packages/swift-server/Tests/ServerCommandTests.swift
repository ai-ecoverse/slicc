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

    func testIsThinElectronModeRequiresElectronAndHostedOriginEnv() throws {
        let electronConfig = ServerConfig.resolve(
            from: try XCTUnwrap(try ServerCommand.parseAsRoot(["--electron"]) as? ServerCommand),
            arguments: ["slicc-server", "--electron"]
        )

        XCTAssertTrue(
            ServerCommand.isThinElectronMode(
                config: electronConfig,
                environment: ["SLICC_HOSTED_LEADER_ORIGIN": "https://www.sliccy.ai"]
            ))

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

        XCTAssertNil(ServerCommand.parseEnvFileSecrets(at: url.appendingPathExtension("gone")))
    }

    func testLoggerLevelMapsTheCliVocabularyOntoSwiftLog() {
        XCTAssertEqual(ServerCommand.loggerLevel(from: "debug"), .debug)

        XCTAssertEqual(ServerCommand.loggerLevel(from: "warn"), .warning)
        XCTAssertEqual(ServerCommand.loggerLevel(from: "error"), .error)
        XCTAssertEqual(ServerCommand.loggerLevel(from: "info"), .info)
        XCTAssertEqual(ServerCommand.loggerLevel(from: "verbose"), .info)
    }

    func testShouldMountThinBridgeCorsOffInLegacyModesWithoutToken() {

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

        XCTAssertEqual(
            ServerConfig.parseMountMapping("/we:ird/dir:/mnt/x"),
            ServerConfig.MountMapping(hostPath: "/we:ird/dir", path: "/mnt/x"))

        XCTAssertEqual(
            ServerConfig.parseMountMapping("~/proj:/mnt/p", homeDirectory: "/Users/me"),
            ServerConfig.MountMapping(hostPath: "/Users/me/proj", path: "/mnt/p"))
        XCTAssertNil(ServerConfig.parseMountMapping("~/proj:/mnt/p", homeDirectory: ""))

        XCTAssertNil(ServerConfig.parseMountMapping("/a:/"))
        XCTAssertNil(ServerConfig.parseMountMapping("rel:/mnt/x"))
        XCTAssertNil(ServerConfig.parseMountMapping("/a:rel"))
        XCTAssertNil(ServerConfig.parseMountMapping("/mnt/only-target"))

        XCTAssertNil(ServerConfig.parseMountMapping("/a:/mnt/a/../b"))
        XCTAssertNil(ServerConfig.parseMountMapping("/a:/mnt//b"))
        XCTAssertNil(ServerConfig.parseMountMapping("/a:/mnt/./b"))
    }
}
