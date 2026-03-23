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
}