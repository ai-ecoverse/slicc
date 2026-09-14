import XCTest

@testable import Sliccstart






@MainActor
final class SliccProcessLeaderProbeTests: XCTestCase {

    func testRescheduleLoopEventuallySetsJoinUrlWhenTrayMintsLate() async throws {
        let connecting = Data(#"{"state":"connecting"}"#.utf8)
        let ready = Data(#"{"state":"connected","joinUrl":"https:

        actor Counter {
            var n = 0
            func tick() -> Int {
                n += 1
                return n
            }
        }
        let counter = Counter()
        
        
        
        
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

        
        
        
        
        try await Task.sleep(nanoseconds: 200_000_000)
        proc.stopAll()

        let countAtStop = await counter.snapshot()
        try await Task.sleep(nanoseconds: 300_000_000)
        let countLater = await counter.snapshot()

        XCTAssertNil(proc.leaderJoinUrl)
        
        
        
        XCTAssertLessThanOrEqual(
            countLater - countAtStop,
            2,
            "loop must stop scheduling new inner probes after the browser record is gone"
        )
    }

    func testStartLeaderProbeReplacesPriorLoopWithoutStacking() async throws {
        let connecting = Data(#"{"state":"connecting"}"#.utf8)
        let ready = Data(#"{"state":"connected","joinUrl":"https:

        actor Counter {
            var n = 0
            func tick() -> Int {
                n += 1
                return n
            }
        }
        let counter = Counter()
        
        
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

    
    
    
    
    
    
    func testProbeWaitsForBrowserRecordRegisteredAfterProbeStart() async throws {
        let ready = Data(#"{"state":"connected","joinUrl":"https:
        let probe = TrayStatusProbe(fetch: { _ in (200, ready) })

        let proc = SliccProcess(trayStatusProbe: probe)
        let helper = try launchSleeper()
        addTeardownBlock { if helper.isRunning { helper.terminate() } }

        
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

    
    
    
    func testProbeGivesUpWhenBrowserRecordNeverAppears() async throws {
        let ready = Data(#"{"state":"connected","joinUrl":"https:
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

    

    

    
    
    
    
    
    func testRefreshAdoptsATrayReMintedAfterDiscovery() async throws {
        let reminted = Data(
            #"{"state":"connected","joinUrl":"https:
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
            #"{"state":"connected","joinUrl":"https:
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
