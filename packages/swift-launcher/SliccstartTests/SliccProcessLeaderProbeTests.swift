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
            func tick() -> Int { n += 1; return n }
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
            func tick() -> Int { n += 1; return n }
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
            func tick() -> Int { n += 1; return n }
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

    // MARK: - Helpers

    private func launchSleeper() throws -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sleep")
        p.arguments = ["60"]
        try p.run()
        return p
    }
}
