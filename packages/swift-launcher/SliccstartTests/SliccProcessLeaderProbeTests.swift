import XCTest

@testable import Sliccstart

/// Drives the re-schedule outer loop in `SliccProcess.startLeaderProbe`
/// through the injected `TrayStatusProbe.fetch` closure so the leader
/// join URL eventually lands when the tray mints late, the loop stops
/// cleanly when the chromiumBrowser record goes away mid-flight, and
/// repeated `startLeaderProbe` calls don't stack concurrent loops.
@MainActor
final class SliccProcessLeaderProbeTests: XCTestCase {

    func testRescheduleLoopEventuallySetsJoinUrlWhenTrayMintsLate() async throws {
        let connecting = Data(#"{"state":"connecting"}"#.utf8)
        let ready = Data(#"{"state":"connected","joinUrl":"https://example.test/join/late.url"}"#.utf8)

        actor Counter {
            var n = 0
            func tick() -> Int {
                n += 1
                return n
            }
        }
        let counter = Counter()
        // First two inner probes give up (4 connecting fetches each), then
        // the third outer round returns the join URL. Mirrors a real
        // slow-booting leader where the tray isn't ready inside the first
        // bounded window.
        let probe = TrayStatusProbe(fetch: { _ in
            let n = await counter.tick()
            return n <= 8 ? (200, connecting) : (200, ready)
        })

        let proc = SliccProcess(trayStatusProbe: probe)
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

        proc.startLeaderProbe(
            servePort: 35710,
            innerMaxAttempts: 4,
            innerRetryDelay: 0,
            outerBackoff: 0
        )

        let deadline = Date().addingTimeInterval(3.0)
        while proc.leaderJoinUrl == nil && Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        XCTAssertEqual(proc.leaderJoinUrl, "https://example.test/join/late.url")
    }

    func testRescheduleLoopStopsWhenBrowserRecordIsRemovedMidFlight() async throws {
        let connecting = Data(#"{"state":"connecting"}"#.utf8)
        actor Counter {
            var n = 0
            func tick() -> Int {
                n += 1
                return n
            }
            func snapshot() -> Int { n }
        }
        let counter = Counter()
        let probe = TrayStatusProbe(fetch: { _ in
            _ = await counter.tick()
            return (200, connecting)
        })

        let proc = SliccProcess(trayStatusProbe: probe)
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

        proc.startLeaderProbe(
            servePort: 35710,
            innerMaxAttempts: 2,
            innerRetryDelay: 0,
            outerBackoff: 0.02
        )

        // Let it cycle a few rounds, then drop the browser. The loop must
        // notice the missing chromiumBrowser record at the next stop-
        // condition check and exit without spinning forever or assigning
        // a stale URL.
        try await Task.sleep(nanoseconds: 200_000_000)
        proc.stopAll()

        let countAtStop = await counter.snapshot()
        try await Task.sleep(nanoseconds: 300_000_000)
        let countLater = await counter.snapshot()

        XCTAssertNil(proc.leaderJoinUrl)
        // A small overshoot is acceptable because one inner discoverJoinUrl
        // can already be in flight when stopAll runs, but the loop must
        // stop scheduling new ones — bound the post-stop fetch count.
        XCTAssertLessThanOrEqual(
            countLater - countAtStop,
            2,
            "loop must stop scheduling new inner probes after the browser record is gone"
        )
    }

    func testStartLeaderProbeReplacesPriorLoopWithoutStacking() async throws {
        let connecting = Data(#"{"state":"connecting"}"#.utf8)
        let ready = Data(#"{"state":"connected","joinUrl":"https://example.test/join/replaced.url"}"#.utf8)

        actor Counter {
            var n = 0
            func tick() -> Int {
                n += 1
                return n
            }
        }
        let counter = Counter()
        // After 6 fetches return the URL — gives the test enough room to
        // call startLeaderProbe twice and still observe a single landing.
        let probe = TrayStatusProbe(fetch: { _ in
            let n = await counter.tick()
            return n <= 6 ? (200, connecting) : (200, ready)
        })

        let proc = SliccProcess(trayStatusProbe: probe)
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

        // First loop, then immediately replace it. The first loop's
        // outer-backoff sleep responds to cancellation; the second loop
        // is the one that should land the URL. If we were stacking
        // loops, both would race to assign — the `leaderJoinUrl == nil`
        // guard inside the assignment still keeps the final value
        // consistent, but the test also asserts the value matches.
        proc.startLeaderProbe(
            servePort: 35710,
            innerMaxAttempts: 2,
            innerRetryDelay: 0,
            outerBackoff: 0.5
        )
        try await Task.sleep(nanoseconds: 30_000_000)
        proc.startLeaderProbe(
            servePort: 35710,
            innerMaxAttempts: 2,
            innerRetryDelay: 0,
            outerBackoff: 0
        )

        let deadline = Date().addingTimeInterval(3.0)
        while proc.leaderJoinUrl == nil && Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        XCTAssertEqual(proc.leaderJoinUrl, "https://example.test/join/replaced.url")
    }

    /// Regression: `reattach` starts the probe from a non-main-actor
    /// context, so the chromiumBrowser launch record can be registered a
    /// beat *after* the loop's first stop-condition check. Treating that
    /// as terminal left `leaderJoinUrl` nil for the whole session after a
    /// smooth update — every Electron/terminal row stuck on "Start a
    /// browser first" and no iCloud session advertised.
    func testProbeWaitsForBrowserRecordRegisteredAfterProbeStart() async throws {
        let ready = Data(#"{"state":"connected","joinUrl":"https://example.test/join/reattached.url"}"#.utf8)
        let probe = TrayStatusProbe(fetch: { _ in (200, ready) })

        let proc = SliccProcess(trayStatusProbe: probe)
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }

        // No launch record yet — exactly the reattach ordering.
        proc.startLeaderProbe(
            servePort: 35710,
            innerMaxAttempts: 2,
            innerRetryDelay: 0,
            outerBackoff: 0.05
        )
        try await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertNil(proc.leaderJoinUrl, "no record yet — nothing to probe against")

        proc._testing_seedLaunchRecord(
            id: "browser-1",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser"
        )

        let deadline = Date().addingTimeInterval(3.0)
        while proc.leaderJoinUrl == nil && Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(proc.leaderJoinUrl, "https://example.test/join/reattached.url")
    }

    /// The grace window is bounded: a caller that starts the probe and then
    /// never spawns (e.g. `spawn` threw on a port clash) must not leave the
    /// loop running forever.
    func testProbeGivesUpWhenBrowserRecordNeverAppears() async throws {
        let ready = Data(#"{"state":"connected","joinUrl":"https://example.test/join/never.url"}"#.utf8)
        actor Counter {
            var n = 0
            func tick() -> Int {
                n += 1
                return n
            }
            func snapshot() -> Int { n }
        }
        let counter = Counter()
        let probe = TrayStatusProbe(fetch: { _ in
            _ = await counter.tick()
            return (200, ready)
        })

        let proc = SliccProcess(trayStatusProbe: probe)
        proc.startLeaderProbe(
            servePort: 35710,
            innerMaxAttempts: 1,
            innerRetryDelay: 0,
            outerBackoff: 0
        )

        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertNil(proc.leaderJoinUrl)
        let fetchCount = await counter.snapshot()
        XCTAssertEqual(fetchCount, 0, "must never probe without a browser record")
    }

    // MARK: - Step decision table

    func testLeaderProbeStepStopsOnceJoinUrlIsSet() {
        XCTAssertEqual(
            SliccProcess.leaderProbeStep(
                joinUrlAlreadySet: true,
                hasBrowserRecord: true,
                hasObservedBrowserRecord: true,
                recordWaitRoundsLeft: 5
            ),
            .stop
        )
    }

    func testLeaderProbeStepProbesWhileBrowserRecordIsLive() {
        XCTAssertEqual(
            SliccProcess.leaderProbeStep(
                joinUrlAlreadySet: false,
                hasBrowserRecord: true,
                hasObservedBrowserRecord: false,
                recordWaitRoundsLeft: 0
            ),
            .probe
        )
    }

    func testLeaderProbeStepWaitsForARecordThatHasNeverAppeared() {
        XCTAssertEqual(
            SliccProcess.leaderProbeStep(
                joinUrlAlreadySet: false,
                hasBrowserRecord: false,
                hasObservedBrowserRecord: false,
                recordWaitRoundsLeft: 1
            ),
            .waitForRecord
        )
    }

    func testLeaderProbeStepStopsWhenAPreviouslySeenRecordGoesAway() {
        XCTAssertEqual(
            SliccProcess.leaderProbeStep(
                joinUrlAlreadySet: false,
                hasBrowserRecord: false,
                hasObservedBrowserRecord: true,
                recordWaitRoundsLeft: 99
            ),
            .stop,
            "a browser that closed must stop the loop, not re-enter the startup grace window"
        )
    }

    func testLeaderProbeStepStopsWhenTheGraceWindowIsExhausted() {
        XCTAssertEqual(
            SliccProcess.leaderProbeStep(
                joinUrlAlreadySet: false,
                hasBrowserRecord: false,
                hasObservedBrowserRecord: false,
                recordWaitRoundsLeft: 0
            ),
            .stop
        )
    }

    // MARK: - Helpers

    // MARK: - Keeping the discovered join URL current

    /// The tray is minted by the browser, not by the launcher: a tab that
    /// reloads or is superseded mints a new one, and the URL discovered at
    /// launch then names a tray with no leader on it. The one-shot probe
    /// stops for good once it has a URL, so without this refresh the
    /// launcher handed followers — and iCloud — a dead join URL.
    func testRefreshAdoptsATrayReMintedAfterDiscovery() async throws {
        let reminted = Data(
            #"{"state":"connected","joinUrl":"https://example.test/join/reminted.url"}"#.utf8)
        let proc = SliccProcess(trayStatusProbe: TrayStatusProbe(fetch: { _ in (200, reminted) }))
        try seedLeader(on: proc)
        proc.leaderJoinUrl = "https://example.test/join/discovered-at-launch.url"

        let refreshed = await proc.refreshLeaderJoinUrl()

        XCTAssertEqual(refreshed, "https://example.test/join/reminted.url")
        XCTAssertEqual(proc.leaderJoinUrl, "https://example.test/join/reminted.url")
    }

    func testRefreshKeepsTheKnownUrlWhenTheLeaderDoesNotAnswer() async throws {
        let proc = SliccProcess(trayStatusProbe: TrayStatusProbe(fetch: { _ in (503, Data()) }))
        try seedLeader(on: proc)
        proc.leaderJoinUrl = "https://example.test/join/known.url"

        let refreshed = await proc.refreshLeaderJoinUrl()

        XCTAssertNil(refreshed)
        XCTAssertEqual(
            proc.leaderJoinUrl,
            "https://example.test/join/known.url",
            "a leader that missed one probe is not a leader that is gone")
    }

    /// A `--join` browser is somebody else's follower; its serve port has no
    /// tray of ours to report, so the refresh must not even ask.
    func testRefreshIgnoresAFollowerBrowser() async throws {
        let proc = SliccProcess(
            trayStatusProbe: TrayStatusProbe(fetch: { _ in
                XCTFail("a follower browser must not be probed for a leader tray")
                return (200, Data())
            }))
        try seedLeader(on: proc, isFollower: true)

        let refreshed = await proc.refreshLeaderJoinUrl()

        XCTAssertNil(refreshed)
        XCTAssertNil(proc.leaderJoinUrl)
    }

    func testTheWatchLoopPicksUpAReMintedTrayWithoutARestart() async throws {
        let reminted = Data(
            #"{"state":"connected","joinUrl":"https://example.test/join/watched.url"}"#.utf8)
        let proc = SliccProcess(trayStatusProbe: TrayStatusProbe(fetch: { _ in (200, reminted) }))
        try seedLeader(on: proc)
        proc.leaderJoinUrl = "https://example.test/join/stale.url"

        proc.startLeaderJoinUrlWatch(interval: 0.01)
        defer { proc.stopLeaderJoinUrlWatch() }

        let deadline = Date().addingTimeInterval(3.0)
        while proc.leaderJoinUrl != "https://example.test/join/watched.url" && Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        XCTAssertEqual(proc.leaderJoinUrl, "https://example.test/join/watched.url")
    }

    @discardableResult
    private func seedLeader(on proc: SliccProcess, isFollower: Bool = false) throws -> Process {
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }
        proc._testing_seedLaunchRecord(
            id: "browser-1",
            process: helper,
            targetType: .chromiumBrowser,
            cdpPort: 39222,
            servePort: 35710,
            targetName: "TestBrowser",
            isFollower: isFollower
        )
        return helper
    }

    private func launchSleeper() throws -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sleep")
        p.arguments = ["60"]
        try p.run()
        return p
    }
}
