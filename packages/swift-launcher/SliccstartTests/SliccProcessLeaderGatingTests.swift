import AppKit
import XCTest
@testable import Sliccstart

/// End-to-end gating: `runtimeState(for:)` must flip an Electron target
/// from `cannotStart(.needsLeader)` to `notRunning` only when BOTH a
/// chromiumBrowser launch record is alive AND `leaderJoinUrl` has been
/// populated by the tray-status probe.
@MainActor
final class SliccProcessLeaderGatingTests: XCTestCase {

    func testElectronGatesOnNeedsLeaderWhenNoBrowserRecord() {
        let proc = SliccProcess()
        let electron = makeElectron()

        XCTAssertFalse(proc.isLeaderReady())
        XCTAssertEqual(
            proc.runtimeState(for: electron, hasAppManagementPermission: true),
            .cannotStart(.needsLeader)
        )
    }

    func testElectronStaysGatedWhenBrowserRunningButNoJoinUrl() throws {
        let proc = SliccProcess()
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }
        proc._testing_seedLaunchRecord(
            id: "browser-1",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser"
        )

        XCTAssertFalse(proc.isLeaderReady(), "running browser alone is not enough — need the join URL too")
        XCTAssertEqual(
            proc.runtimeState(for: makeElectron(), hasAppManagementPermission: true),
            .cannotStart(.needsLeader)
        )
    }

    func testElectronUngatesWhenBrowserAndJoinUrlBothPresent() throws {
        let proc = SliccProcess()
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }
        proc._testing_seedLaunchRecord(
            id: "browser-1",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser"
        )
        proc.leaderJoinUrl = "https://example.test/join/abc.def"

        XCTAssertTrue(proc.isLeaderReady())
        XCTAssertEqual(
            proc.runtimeState(for: makeElectron(), hasAppManagementPermission: true),
            .notRunning
        )
    }

    func testStopAllClearsLeaderJoinUrl() throws {
        let proc = SliccProcess()
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }
        proc._testing_seedLaunchRecord(
            id: "browser-1",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser"
        )
        proc.leaderJoinUrl = "https://example.test/join/abc.def"
        XCTAssertTrue(proc.isLeaderReady())

        proc.stopAll()

        XCTAssertNil(proc.leaderJoinUrl)
        XCTAssertFalse(proc.isLeaderReady())
    }

    // MARK: - Helpers

    private func makeElectron() -> AppTarget {
        // Synthetic path that won't match any installed app — keeps
        // `isElectronAppRunning` false regardless of the developer's
        // machine state, so the test asserts on the gating logic
        // alone rather than on what's open on macOS at test time.
        let path = "/Applications/Sliccstart-Test-DoesNotExist-\(UUID().uuidString).app"
        return AppTarget(
            id: path,
            name: "TestFollower",
            path: path,
            executablePath: "\(path)/Contents/MacOS/TestFollower",
            type: .electronApp,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .supported,
            isDebugBuild: false,
            originalAppPath: nil
        )
    }

    private func launchSleeper() throws -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sleep")
        p.arguments = ["60"]
        try p.run()
        return p
    }
}
