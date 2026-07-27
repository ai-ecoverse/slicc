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
        var exposedURL: URL?
        var launchedCommand: String?
        let service = TerminalFollowerLaunchService(
            findCliBinary: { nil },
            downloadCli: { progress in
                progress(.downloading(attempt: 1, totalAttempts: 1))
                downloaded = true
                return URL(fileURLWithPath: "/managed/slicc")
            },
            exposeCli: { exposedURL = $0 },
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
        XCTAssertEqual(exposedURL?.path, "/managed/slicc")
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

    func testPathExposureFailureDoesNotBlockManagedLaunch() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let managed = SliccCliLocator.managedBinDirectory(homeDirectory: home)
            .appendingPathComponent("slicc")
        let exposure = SliccCliPathExposure(
            homeDirectory: home,
            isDirectoryWritable: { _ in false }
        )
        var launchedCommand: String?
        let service = TerminalFollowerLaunchService(
            findCliBinary: { managed.path },
            downloadCli: { _ in
                XCTFail("download should be skipped")
                return managed
            },
            exposeCli: { XCTAssertEqual(exposure.expose($0), .failed) },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, command in launchedCommand = command }
        )

        try await service.launch(
            target: target(type: .terminal),
            joinURL: "https://example.test/join/token.secret",
            progressHandler: { _ in }
        )

        XCTAssertNotNil(launchedCommand)
        XCTAssertTrue(launchedCommand?.contains("https://example.test/join/token.secret follow /bin/zsh -c") == true)
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

    func testSliccProcessCoalescesConcurrentTerminalLaunches() async throws {
        var downloadContinuation: CheckedContinuation<URL, Never>?
        var downloadCount = 0
        var launchCount = 0
        let service = TerminalFollowerLaunchService(
            findCliBinary: { nil },
            downloadCli: { _ in
                downloadCount += 1
                return await withCheckedContinuation { downloadContinuation = $0 }
            },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, _ in launchCount += 1 }
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
        let terminal = target(type: .terminal)

        let firstLaunch = Task { try await process.launchTerminalFollower(terminal) }
        while downloadContinuation == nil { await Task.yield() }
        try await process.launchTerminalFollower(terminal)

        XCTAssertEqual(downloadCount, 1)
        XCTAssertTrue(process.isLaunchingTerminalFollower)
        downloadContinuation?.resume(returning: URL(fileURLWithPath: "/managed/slicc"))
        try await firstLaunch.value
        XCTAssertEqual(launchCount, 1)
        XCTAssertFalse(process.isLaunchingTerminalFollower)
    }

    func testSliccProcessReleasesLaunchGuardAfterError() async throws {
        var launchCount = 0
        let expected = TerminalLauncher.LaunchError.couldNotStart("Terminal")
        let service = TerminalFollowerLaunchService(
            findCliBinary: { "/usr/local/bin/slicc" },
            downloadCli: { _ in URL(fileURLWithPath: "/unused") },
            resolveLoginShell: { "/bin/zsh" },
            loadTemplate: { FollowCommandTemplate.defaultTemplate },
            launchTerminal: { _, _ in
                launchCount += 1
                if launchCount == 1 { throw expected }
            }
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
        let terminal = target(type: .terminal)

        do {
            try await process.launchTerminalFollower(terminal)
            XCTFail("expected first launch to fail")
        } catch {
            XCTAssertEqual(error as? TerminalLauncher.LaunchError, expected)
        }
        XCTAssertFalse(process.isLaunchingTerminalFollower)

        try await process.launchTerminalFollower(terminal)
        XCTAssertEqual(launchCount, 2)
        XCTAssertFalse(process.isLaunchingTerminalFollower)
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
