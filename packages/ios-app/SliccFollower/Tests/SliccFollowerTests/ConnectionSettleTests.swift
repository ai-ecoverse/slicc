import Foundation
import XCTest

@testable import SliccFollower

/// The hold that keeps a WebRTC blip off the chat surface.
///
/// Every test drives the hold by hand through an injected sleep, so the state
/// machine is exercised without spending the real settle window and without a
/// wall-clock race deciding the result.
@MainActor
final class ConnectionSettleTests: XCTestCase {

    /// A sleep the test releases explicitly. A hold that must NOT expire is
    /// simply never released; one that must is released on demand.
    private final class ManualHold: @unchecked Sendable {
        private let lock = NSLock()
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var durations: [Duration] = []

        var sleep: @Sendable (Duration) async throws -> Void {
            { duration in
                self.lock.lock()
                self.durations.append(duration)
                self.lock.unlock()
                await withCheckedContinuation { continuation in
                    self.lock.lock()
                    self.waiters.append(continuation)
                    self.lock.unlock()
                }
            }
        }

        /// Durations the settler asked to wait, in order.
        var requested: [Duration] {
            lock.lock()
            defer { lock.unlock() }
            return durations
        }

        /// Resume every parked sleep. Also called from teardown: a checked
        /// continuation that is never resumed is a leak the runtime complains
        /// about, even when the test that created it has already passed.
        func release() {
            lock.lock()
            let pending = waiters
            waiters = []
            lock.unlock()
            pending.forEach { $0.resume() }
        }
    }

    private var hold: ManualHold!

    override func setUp() {
        super.setUp()
        hold = ManualHold()
    }

    override func tearDown() {
        hold.release()
        hold = nil
        super.tearDown()
    }

    private func makeSettler(
        initial: ConnectionHealth = ConnectionHealth(state: .connected)
    ) -> (ConnectionSettler, Recorder) {
        let recorder = Recorder()
        let settler = ConnectionSettler(
            initial: initial,
            holdDuration: .seconds(2),
            sleep: hold.sleep)
        settler.onChange = { recorder.published.append($0) }
        return (settler, recorder)
    }

    /// Boxed so the change handler can record without capturing a `var`.
    private final class Recorder {
        var published: [ConnectionHealth] = []
    }

    // MARK: - Into trouble

    /// The reason the type exists: a drop that comes back inside the window is
    /// never rendered at all, not rendered and quickly undone.
    func testABlipThatHealsInsideTheHoldNeverReachesTheUI() async {
        let (settler, recorder) = makeSettler()

        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 1))
        await holdParks()
        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connected))

        settler.ingest(ConnectionHealth(state: .connected))
        await expireHold()

        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connected))
        XCTAssertTrue(
            recorder.published.isEmpty,
            "A blip that healed inside the hold must publish nothing at all")
    }

    /// Trouble that outlasts the window is real trouble and has to show.
    func testTroubleThatOutlastsTheHoldIsPublished() async {
        let (settler, recorder) = makeSettler()
        let dropped = ConnectionHealth(state: .reconnecting, reconnectAttempt: 1)

        settler.ingest(dropped)
        await holdParks()
        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connected))

        await expireHold()

        XCTAssertEqual(settler.settled, dropped)
        XCTAssertEqual(recorder.published, [dropped])
        XCTAssertEqual(hold.requested, [.seconds(2)], "The hold should be the configured window")
    }

    /// Each drop is weighed on its own: a second blip gets a full window rather
    /// than inheriting whatever was left of the first one's.
    func testASecondBlipEarnsItsOwnHold() async {
        let (settler, recorder) = makeSettler()

        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 1))
        await holdParks()
        settler.ingest(ConnectionHealth(state: .connected))
        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 1))
        await expireHold()

        XCTAssertEqual(hold.requested.count, 2, "Each drop should ask for its own hold")
        XCTAssertEqual(
            recorder.published, [ConnectionHealth(state: .reconnecting, reconnectAttempt: 1)],
            "Only the drop that outlasted its hold should reach the UI")
    }

    /// The window is measured from the reading that broke health, so trouble
    /// that keeps changing shape cannot defer the treatment forever: a
    /// reconnect loop bumps its attempt counter roughly once a second, and
    /// restarting the clock on each bump would outrun any hold.
    func testTroubleArrivingDuringTheHoldDoesNotRestartIt() async {
        let (settler, recorder) = makeSettler()

        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 1))
        await holdParks()
        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 2))
        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 3))
        await expireHold()

        XCTAssertEqual(hold.requested.count, 1, "The original deadline should still stand")
        XCTAssertEqual(
            recorder.published, [ConnectionHealth(state: .reconnecting, reconnectAttempt: 3)],
            "The hold should publish the latest reading, once")
    }

    // MARK: - Out of trouble

    /// Recovery is the transition nobody needs protecting from.
    func testRecoveryIsPublishedImmediately() async {
        let (settler, recorder) = makeSettler(initial: ConnectionHealth(state: .reconnecting))

        settler.ingest(ConnectionHealth(state: .connected))

        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connected))
        XCTAssertEqual(recorder.published, [ConnectionHealth(state: .connected)])
        XCTAssertTrue(hold.requested.isEmpty, "Recovery must not wait on a hold")
    }

    /// Once the treatment is on screen its details keep up: an attempt counter
    /// frozen at 1 for a whole reconnect budget would read as a hang.
    func testTroubleRefinesLiveOnceItIsOnScreen() async {
        let (settler, recorder) = makeSettler(
            initial: ConnectionHealth(state: .reconnecting, reconnectAttempt: 1))

        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 2))
        settler.ingest(ConnectionHealth(state: .gaveUp))

        XCTAssertEqual(settler.settled, ConnectionHealth(state: .gaveUp))
        XCTAssertEqual(recorder.published.count, 2)
        XCTAssertTrue(hold.requested.isEmpty, "Trouble → trouble must not wait on a hold")
    }

    /// A stall is trouble too, so it earns the same hold — and a leader that
    /// answers again inside the window never disturbs the composer.
    func testAStallIsHeldLikeAnyOtherTrouble() async {
        let (settler, recorder) = makeSettler()

        settler.ingest(ConnectionHealth(state: .connected, isStalled: true))
        await holdParks()
        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connected))

        settler.ingest(ConnectionHealth(state: .connected, isStalled: false))
        await expireHold()

        XCTAssertTrue(recorder.published.isEmpty)
    }

    // MARK: - Launch and pinned states

    /// There is no healthy state to protect at launch, so a cold start that
    /// begins disconnected says so at once instead of a window later.
    func testTroubleAtLaunchIsNotHeld() async {
        let (settler, recorder) = makeSettler(initial: ConnectionHealth(state: .disconnected))

        settler.ingest(ConnectionHealth(state: .connecting))

        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connecting))
        XCTAssertEqual(recorder.published, [ConnectionHealth(state: .connecting)])
        XCTAssertTrue(hold.requested.isEmpty)
    }

    /// The UI-test hooks pin a state no transport produced; it has to be on
    /// screen when the test looks.
    func testSettleImmediatelySkipsTheHold() async {
        let (settler, recorder) = makeSettler()
        let stalled = ConnectionHealth(state: .connected, isStalled: true)

        settler.settleImmediately(stalled)

        XCTAssertEqual(settler.settled, stalled)
        XCTAssertEqual(recorder.published, [stalled])
        XCTAssertTrue(hold.requested.isEmpty)
    }

    /// A pinned state also drops a hold already in flight, or the fixture would
    /// be overwritten a window later by whatever the transport was doing.
    func testSettleImmediatelyCancelsAPendingHold() async {
        let (settler, recorder) = makeSettler()
        let pinned = ConnectionHealth(state: .failed)

        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 1))
        await holdParks()
        settler.settleImmediately(pinned)
        await expireHold()

        XCTAssertEqual(settler.settled, pinned)
        XCTAssertEqual(recorder.published, [pinned])
    }

    /// Re-publishing an unchanged value would churn every SwiftUI view that
    /// observes it, once per ping.
    func testAnUnchangedReadingPublishesNothing() async {
        let (settler, recorder) = makeSettler()

        settler.ingest(ConnectionHealth(state: .connected))
        settler.settleImmediately(ConnectionHealth(state: .connected))

        XCTAssertTrue(recorder.published.isEmpty)
        XCTAssertTrue(hold.requested.isEmpty)
    }

    // MARK: - Helpers

    /// Wait for the hold to actually start sleeping.
    ///
    /// `ingest` schedules the hold on a `Task`, which cannot begin while this
    /// (main-actor) test still holds the actor — so releasing before the hold
    /// has parked releases nothing, and the hold then sleeps forever.
    private func holdParks(_ expected: Int = 1) async {
        for _ in 0..<100 where hold.requested.count < expected {
            await Task.yield()
        }
        XCTAssertEqual(hold.requested.count, expected, "the hold should have started sleeping")
    }

    /// Expire every hold and let the resumed tasks reach their publish.
    /// Releases repeatedly, so a hold that only parks on a later turn of the
    /// executor is expired too rather than sleeping past the assertions.
    private func expireHold() async {
        for _ in 0..<100 {
            hold.release()
            await Task.yield()
        }
    }
}
