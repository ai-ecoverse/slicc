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

    func testStaticRootIsCapturedInResolvedConfig() throws {
        let parsed = try ServerCommand.parseAsRoot(["--static-root", "/tmp/slicc/dist/ui"])
        let command = try XCTUnwrap(parsed as? ServerCommand)
        let config = ServerConfig.resolve(
            from: command,
            arguments: ["slicc-server", "--static-root", "/tmp/slicc/dist/ui"]
        )

        XCTAssertEqual(config.staticRoot, "/tmp/slicc/dist/ui")
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

    func testResolveStaticRootPrefersExplicitPath() {
        let root = ServerCommand.resolveStaticRoot(
            explicitStaticRoot: "/explicit/dist/ui",
            repositoryRoot: URL(fileURLWithPath: "/repo")
        )

        XCTAssertEqual(root, "/explicit/dist/ui")
    }

    func testResolveStaticRootUsesBundledResources() {
        let root = ServerCommand.resolveStaticRoot(
            explicitStaticRoot: nil,
            repositoryRoot: URL(fileURLWithPath: "/repo"),
            bundlePath: "/Applications/Sliccstart.app",
            resourcePath: "/Applications/Sliccstart.app/Contents/Resources"
        )

        XCTAssertEqual(root, "/Applications/Sliccstart.app/Contents/Resources/slicc/dist/ui")
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
}