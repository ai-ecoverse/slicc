import Foundation
import XCTest

@testable import SliccFollower

/// Stall/recover/dead transitions for `DataChannelKeepalive` (#1793).
///
/// Every test drives `tick()` directly rather than waiting on the ping timer,
/// so the state machine is exercised deterministically and no test needs a live
/// peer or a wall-clock delay.
final class KeepaliveTests: XCTestCase {
    /// Thread-safe tally for the actor's `@Sendable` callbacks.
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var counts: [String: Int] = [:]

        func record(_ event: String) {
            lock.lock()
            defer { lock.unlock() }
            counts[event, default: 0] += 1
        }

        func count(_ event: String) -> Int {
            lock.lock()
            defer { lock.unlock() }
            return counts[event] ?? 0
        }
    }

    /// `tick` only counts a miss when it is already awaiting a pong, so the
    /// first tick just sends. Crossing `maxMissed` therefore takes
    /// `maxMissed + 1` ticks.
    private func makeKeepalive(
        recorder: Recorder,
        transportOpen: Bool,
        maxMissed: Int = 2,
        hardMaxMissed: Int = 4
    ) -> DataChannelKeepalive {
        DataChannelKeepalive(
            sendPing: { recorder.record("ping") },
            onDead: { recorder.record("dead") },
            isTransportOpen: { transportOpen },
            onStalled: { recorder.record("stalled") },
            onRecovered: { recorder.record("recovered") },
            pingInterval: 10,
            maxMissed: maxMissed,
            hardMaxMissed: hardMaxMissed
        )
    }

    func testAnOpenTransportStallsInsteadOfDying() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(recorder: recorder, transportOpen: true)

        for _ in 0..<3 { await keepalive.tick() }

        XCTAssertEqual(recorder.count("stalled"), 1, "Crossing maxMissed should report a stall")
        XCTAssertEqual(recorder.count("dead"), 0, "A reachable peer must not be declared dead")
        let stalled = await keepalive.isStalled
        XCTAssertTrue(stalled)
    }

    func testAStalledKeepaliveKeepsProbing() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(recorder: recorder, transportOpen: true)

        for _ in 0..<3 { await keepalive.tick() }
        let pingsAtStall = recorder.count("ping")
        await keepalive.tick()

        XCTAssertGreaterThan(
            recorder.count("ping"), pingsAtStall,
            "A stall must not stop the timer — recovery is only observable by probing")
        XCTAssertEqual(recorder.count("stalled"), 1, "The stall is reported once, not per tick")
    }

    func testAPongAfterAStallReportsRecovery() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(recorder: recorder, transportOpen: true)

        for _ in 0..<3 { await keepalive.tick() }
        await keepalive.receivedPong()

        XCTAssertEqual(recorder.count("recovered"), 1)
        XCTAssertEqual(recorder.count("dead"), 0, "Recovery must not require renegotiation")
        let stalled = await keepalive.isStalled
        XCTAssertFalse(stalled)
        let missed = await keepalive.missed
        XCTAssertEqual(missed, 0)
    }

    /// A peer that pings us has proved liveness just as well as one that pongs.
    func testAnInboundPingAlsoClearsAStall() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(recorder: recorder, transportOpen: true)

        for _ in 0..<3 { await keepalive.tick() }
        await keepalive.receivedPing()

        XCTAssertEqual(recorder.count("recovered"), 1)
        let stalled = await keepalive.isStalled
        XCTAssertFalse(stalled)
    }

    func testTheHardDeadlineStillKillsAStalledPeer() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(recorder: recorder, transportOpen: true)

        for _ in 0..<5 { await keepalive.tick() }

        XCTAssertEqual(recorder.count("stalled"), 1)
        XCTAssertEqual(
            recorder.count("dead"), 1,
            "hardMaxMissed must still terminate a peer that never answers")
    }

    /// Callers that omit `isTransportOpen` keep the pre-stall semantics.
    func testAClosedTransportDiesAtMaxMissed() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(recorder: recorder, transportOpen: false)

        for _ in 0..<3 { await keepalive.tick() }

        XCTAssertEqual(recorder.count("dead"), 1, "A closed transport dies at maxMissed")
        XCTAssertEqual(recorder.count("stalled"), 0, "A closed transport cannot be merely stalled")
    }

    func testTheDefaultTransportGatePreservesTheOldBehavior() async {
        let recorder = Recorder()
        let keepalive = DataChannelKeepalive(
            sendPing: { recorder.record("ping") },
            onDead: { recorder.record("dead") },
            pingInterval: 10,
            maxMissed: 2
        )

        for _ in 0..<3 { await keepalive.tick() }

        XCTAssertEqual(recorder.count("dead"), 1)
    }

    /// The boundary the initializer permits: equal thresholds mean the hard
    /// deadline lands exactly on the soft one, so there is no stall window.
    func testEqualThresholdsLeaveNoStallWindow() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(
            recorder: recorder, transportOpen: true, maxMissed: 2, hardMaxMissed: 2)

        for _ in 0..<3 { await keepalive.tick() }

        XCTAssertEqual(recorder.count("dead"), 1)
        XCTAssertEqual(recorder.count("stalled"), 0)
    }

    /// Stopping is terminal, so a late pong must not announce a recovery for a
    /// state machine that has already given up.
    func testStopSuppressesALateRecovery() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(recorder: recorder, transportOpen: true)

        for _ in 0..<3 { await keepalive.tick() }
        await keepalive.stop()
        await keepalive.receivedPong()

        XCTAssertEqual(recorder.count("recovered"), 0)
        let stalled = await keepalive.isStalled
        XCTAssertFalse(stalled)
    }

    func testTickAfterStopDoesNothing() async {
        let recorder = Recorder()
        let keepalive = makeKeepalive(recorder: recorder, transportOpen: true)

        await keepalive.stop()
        await keepalive.tick()

        XCTAssertEqual(recorder.count("ping"), 0)
        XCTAssertEqual(recorder.count("dead"), 0)
    }
}

/// Backoff schedule for the bounded reconnect (#1793).
final class ReconnectBackoffTests: XCTestCase {
    func testDelaysGrowGeometricallyThenCap() {
        XCTAssertEqual(ReconnectBackoff.delay(forAttempt: 1), 1)
        XCTAssertEqual(ReconnectBackoff.delay(forAttempt: 2), 2)
        XCTAssertEqual(ReconnectBackoff.delay(forAttempt: 3), 4)
        XCTAssertEqual(ReconnectBackoff.delay(forAttempt: 4), 8)
        XCTAssertEqual(ReconnectBackoff.delay(forAttempt: 5), 16)
    }

    func testDelayIsCappedAtMaxDelay() {
        XCTAssertEqual(
            ReconnectBackoff.delay(forAttempt: 6), ReconnectBackoff.maxDelay,
            "32s would exceed the cap and must clamp")
        XCTAssertEqual(
            ReconnectBackoff.delay(forAttempt: ReconnectBackoff.maxAttempts),
            ReconnectBackoff.maxDelay)
    }

    /// A non-positive attempt is not a real attempt; it must not produce a
    /// negative or fractional delay via `pow`.
    func testNonPositiveAttemptsFallBackToTheBaseDelay() {
        XCTAssertEqual(ReconnectBackoff.delay(forAttempt: 0), ReconnectBackoff.baseDelay)
        XCTAssertEqual(ReconnectBackoff.delay(forAttempt: -3), ReconnectBackoff.baseDelay)
    }

    /// The whole budget must stay bounded — a follower that retries forever is
    /// the bug this replaces, just slower.
    func testTheTotalBudgetIsBounded() {
        let total = (1...ReconnectBackoff.maxAttempts)
            .map { ReconnectBackoff.delay(forAttempt: $0) }
            .reduce(0, +)
        XCTAssertLessThan(total, 300, "Ten attempts should settle well inside five minutes")
        XCTAssertGreaterThan(total, 30, "…but still spread out enough to outlast a blip")
    }
}
