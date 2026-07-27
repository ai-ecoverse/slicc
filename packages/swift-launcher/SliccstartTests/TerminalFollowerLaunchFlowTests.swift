import AppKit
import XCTest
@testable import Sliccstart

@MainActor
final class TerminalFollowerLaunchFlowTests: XCTestCase {
    func testVisibleSectionOrderPlacesTerminalsBeforeExtension() {
        let sections = AppListSection.visibleSections(for: [
            target(type: .chromiumBrowser),
            target(type: .electronApp),
            target(type: .terminal),
        ])

        XCTAssertEqual(sections, [.browsers, .desktopApps, .terminals, .browserExtension])
        XCTAssertEqual(AppListSection.visibleSections(for: []), [.browserExtension])
    }

    func testDecisionFlowGatesLeaderThenWarnsThenDownloadsThenLaunches() {
        XCTAssertEqual(nextStep(false, false, false, false), .blockedByMissingLeader)
        XCTAssertEqual(nextStep(true, false, false, false), .showWarning)
        XCTAssertEqual(nextStep(true, false, true, false), .confirmDownload)
        XCTAssertEqual(nextStep(true, false, true, true), .launch)
    }

    func testWarningSuppressionSkipsWarning() {
        XCTAssertEqual(nextStep(true, true, false, true), .launch)
        XCTAssertEqual(nextStep(true, true, false, false), .confirmDownload)
    }

    func testMissingCliDownloadsThenExpandsAndLaunches() async throws {
        var downloaded = false
        var launchedCommand: String?
        let service = TerminalFollowerLaunchService(
            findCliBinary: { nil },
            downloadCli: { progress in
                progress(.downloading(attempt: 1, totalAttempts: 1))
                downloaded = true
                return URL(fileURLWithPath: "/managed/slicc")
            },
            resolveLoginShell: { "/bin/fish" },
            loadTemplate: { "{slicc} {joinUrl} follow {shell} -c" },
            launchTerminal: { _, command in launchedCommand = command }
        )

        try await service.launch(
            target: target(type: .terminal),
            joinURL: "https://example.test/join/token.secret",
            progressHandler: { _ in }
        )

        XCTAssertTrue(downloaded)
        XCTAssertEqual(
            launchedCommand,
            "/managed/slicc https://example.test/join/token.secret follow /bin/fish -c"
        )
    }

    func testExistingCliSkipsDownloadAndLaunchErrorsPropagate() async {
        let expected = TerminalLauncher.LaunchError.couldNotStart("Terminal")
        let service = TerminalFollowerLaunchService(
            findCliBinary: { "/usr/local/bin/slicc" },
            downloadCli: { _ in
                XCTFail("download should be skipped")
                return URL(fileURLWithPath: "/unused")
            },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, _ in throw expected }
        )

        do {
            try await service.launch(
                target: target(type: .terminal),
                joinURL: "https://example.test/join/token.secret",
                progressHandler: { _ in }
            )
            XCTFail("expected launch error")
        } catch {
            XCTAssertEqual(error as? TerminalLauncher.LaunchError, expected)
        }
    }

    func testSliccProcessWiresLeaderURLIntoTerminalLaunchService() async throws {
        var launchedCommand: String?
        let service = TerminalFollowerLaunchService(
            findCliBinary: { "/usr/local/bin/slicc" },
            downloadCli: { _ in URL(fileURLWithPath: "/unused") },
            resolveLoginShell: { "/bin/fish" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, command in launchedCommand = command }
        )
        let process = SliccProcess(terminalFollowerLaunchService: service)
        let browserHelper = try launchSleeper()
        addTeardownBlock { if browserHelper.isRunning { browserHelper.terminate() } }
        process._testing_seedLaunchRecord(
            id: "browser",
            process: browserHelper,
            targetType: .chromiumBrowser,
            cdpPort: 39_222,
            servePort: 35_710,
            targetName: "Browser"
        )
        process.leaderJoinUrl = "https://example.test/join/token.secret"

        try await process.launchTerminalFollower(target(type: .terminal))

        XCTAssertEqual(
            launchedCommand,
            "/usr/local/bin/slicc https://example.test/join/token.secret follow /bin/fish -c"
        )
        XCTAssertFalse(process.isLaunchingTerminalFollower)
    }

    func testSliccProcessRejectsTerminalLaunchWithoutLeader() async {
        let process = SliccProcess(terminalFollowerLaunchService: unusedService())

        do {
            try await process.launchTerminalFollower(target(type: .terminal))
            XCTFail("expected missing leader error")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Start a browser session before opening a terminal follower.")
        }
    }

    private func nextStep(
        _ leaderReady: Bool,
        _ warningSuppressed: Bool,
        _ warningAcknowledged: Bool,
        _ cliAvailable: Bool
    ) -> TerminalLaunchNextStep {
        TerminalLaunchDecision.nextStep(
            leaderReady: leaderReady,
            warningSuppressed: warningSuppressed,
            warningAcknowledged: warningAcknowledged,
            cliAvailable: cliAvailable
        )
    }

    private func target(type: AppTargetType) -> AppTarget {
        AppTarget(
            id: UUID().uuidString,
            name: type == .terminal ? "Terminal" : "Test",
            path: "/Applications/Test.app",
            executablePath: "/Applications/Test.app/Contents/MacOS/Test",
            type: type,
            icon: NSImage(),
            debugSupport: .unknown,
            isDebugBuild: false,
            originalAppPath: nil
        )
    }

    private func unusedService() -> TerminalFollowerLaunchService {
        TerminalFollowerLaunchService(
            findCliBinary: { nil },
            downloadCli: { _ in URL(fileURLWithPath: "/unused") },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, _ in XCTFail("launch should not be reached") }
        )
    }

    private func launchSleeper() throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["60"]
        try process.run()
        return process
    }
}