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

    func testFollowerBrowserDoesNotCountAsLeader() throws {
        let proc = SliccProcess()
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }
        proc._testing_seedLaunchRecord(
            id: "follower-1",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "FollowerBrowser",
            isFollower: true
        )
        proc.leaderJoinUrl = nil

        XCTAssertFalse(proc.isLeaderReady(), "a --join follower browser must not gate as this device's leader")
        XCTAssertEqual(
            proc.runtimeState(for: makeElectron(), hasAppManagementPermission: true),
            .cannotStart(.needsLeader)
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

    func testLaunchBrowserFollowerRejectsNonBrowserTarget() {
        let proc = SliccProcess()
        XCTAssertThrowsError(
            try proc.launchBrowserFollower(makeElectron(), joinUrl: "https://x.test/join/a.b")
        )
    }

    func testLaunchBrowserFollowerRejectsEmptyJoinURL() {
        let proc = SliccProcess()
        XCTAssertThrowsError(try proc.launchBrowserFollower(makeBrowser(), joinUrl: ""))
    }

    func testLaunchBrowserFollowerNoOpsWhenBrowserAlreadyRunning() throws {
        let proc = SliccProcess()
        let browser = makeBrowser()
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }
        proc._testing_seedLaunchRecord(
            id: browser.id,
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39321,
            servePort: 35821,
            targetName: browser.name
        )
        XCTAssertTrue(proc.isRunning(browser))
        // Already running → early return, never reaches the (test-unavailable)
        // slicc-server spawn.
        XCTAssertNoThrow(try proc.launchBrowserFollower(browser, joinUrl: "https://x.test/join/a.b"))
    }

    func testLeaderTargetNameIgnoresFollowerRecords() throws {
        let proc = SliccProcess()
        let follower = try launchSleeper()
        addTeardownBlock { if follower.isRunning { follower.terminate() } }
        proc._testing_seedLaunchRecord(
            id: "follower",
            process: follower,
            targetType: .chromiumBrowser,
            cdpPort: 39331,
            servePort: 35831,
            targetName: "FollowerBrowser",
            isFollower: true
        )
        XCTAssertNil(proc.leaderTargetName)

        let leader = try launchSleeper()
        addTeardownBlock { if leader.isRunning { leader.terminate() } }
        proc._testing_seedLaunchRecord(
            id: "leader",
            process: leader,
            targetType: .chromiumBrowser,
            cdpPort: 39332,
            servePort: 35832,
            targetName: "LeaderBrowser"
        )
        XCTAssertEqual(proc.leaderTargetName, "LeaderBrowser")
    }

    // MARK: - Helpers

    private func makeBrowser() -> AppTarget {
        let path = "/Applications/Sliccstart-Test-Browser-\(UUID().uuidString).app"
        return AppTarget(
            id: path,
            name: "TestBrowser",
            path: path,
            executablePath: "\(path)/Contents/MacOS/TestBrowser",
            type: .chromiumBrowser,
            icon: NSImage(size: NSSize(width: 1, height: 1)),
            debugSupport: .unknown,
            isDebugBuild: false,
            originalAppPath: nil,
            bundleId: "com.test.browser"
        )
    }

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
