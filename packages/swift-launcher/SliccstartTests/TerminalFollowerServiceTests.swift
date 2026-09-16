import AppKit
import XCTest

@testable import Sliccstart

@MainActor
final class TerminalFollowerServiceTests: XCTestCase {
    func testIsCliAvailableReflectsLocatorResult() {
        XCTAssertTrue(makeService(cliPath: "/usr/local/bin/slicc").isCliAvailable())
        XCTAssertFalse(makeService(cliPath: nil).isCliAvailable())
    }

    func testSliccProcessExposesTerminalCliAvailability() {
        let available = SliccProcess(terminalFollowerLaunchService: makeService(cliPath: "/usr/local/bin/slicc"))
        XCTAssertTrue(available.isTerminalCliAvailable())

        let missing = SliccProcess(terminalFollowerLaunchService: makeService(cliPath: nil))
        XCTAssertFalse(missing.isTerminalCliAvailable())
    }

    func testLiveServiceProbeAgreesWithLocator() {
        XCTAssertEqual(
            TerminalFollowerLaunchService.live.isCliAvailable(),
            SliccCliLocator().findCliBinary() != nil
        )
    }

    func testLaunchDownloadsCliWhenMissingAndExposesIt() async throws {
        let downloaded = URL(fileURLWithPath: "/downloads/slicc")
        var exposed: URL?
        var launchedCommand: String?
        let service = TerminalFollowerLaunchService(
            findCliBinary: { nil },
            downloadCli: { progressHandler in
                progressHandler(.downloading(attempt: 1, totalAttempts: 3))
                return downloaded
            },
            exposeCli: { exposed = $0 },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, command in launchedCommand = command }
        )

        try await service.launch(
            target: terminalTarget(),
            joinURL: "https://remote.test/join/token.secret",
            progressHandler: { _ in }
        )

        XCTAssertEqual(exposed, downloaded)
        XCTAssertEqual(
            launchedCommand,
            "/downloads/slicc https://remote.test/join/token.secret follow /bin/zsh -c"
        )
    }

    func testLaunchTerminalFollowerPublishesDownloadProgress() async throws {
        let service = TerminalFollowerLaunchService(
            findCliBinary: { nil },
            downloadCli: { progressHandler in
                progressHandler(.installing)
                return URL(fileURLWithPath: "/downloads/slicc")
            },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, _ in }
        )
        let process = SliccProcess(terminalFollowerLaunchService: service)

        try await process.launchTerminalFollower(
            terminalTarget(),
            joinURLOverride: "https://remote.test/join/token.secret"
        )

        await Task.yield()

        XCTAssertEqual(process.terminalCliDownloadProgress, .installing)
    }

    func testFreshProcessReportsNoLeaderOrFollower() {
        let process = SliccProcess(terminalFollowerLaunchService: makeService(cliPath: nil))
        XCTAssertNil(process.leaderBrowserEndpoint)
        XCTAssertFalse(process.isRunningAsFollower(terminalTarget()))
    }

    func testFreshBootstrapperIsIdle() {
        let bootstrapper = SliccBootstrapper()
        XCTAssertEqual(bootstrapper.progressMessage, "")
        XCTAssertFalse(bootstrapper.isWorking)
        XCTAssertNil(bootstrapper.lastError)
        XCTAssertTrue(SliccBootstrapper.defaultSliccDir.hasSuffix("/.slicc/slicc"))
    }

    private func makeService(cliPath: String?) -> TerminalFollowerLaunchService {
        TerminalFollowerLaunchService(
            findCliBinary: { cliPath },
            downloadCli: { _ in URL(fileURLWithPath: "/unused") },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, _ in }
        )
    }

    private func terminalTarget() -> AppTarget {
        AppTarget(
            id: UUID().uuidString,
            name: "Terminal",
            path: "/Applications/Terminal.app",
            executablePath: "/Applications/Terminal.app/Contents/MacOS/Terminal",
            type: .terminal,
            icon: NSImage(),
            debugSupport: .unknown,
            isDebugBuild: false,
            originalAppPath: nil
        )
    }
}
