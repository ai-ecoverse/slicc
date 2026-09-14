import Foundation
import XCTest

@testable import SliccFollower






@MainActor
final class ConnectionSettleTests: XCTestCase {

    
    
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

        
        var requested: [Duration] {
            lock.lock()
            defer { lock.unlock() }
            return durations
        }

        
        
        
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

    
    private final class Recorder {
        var published: [ConnectionHealth] = []
    }

    

    
    
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

    

    
    func testRecoveryIsPublishedImmediately() async {
        let (settler, recorder) = makeSettler(initial: ConnectionHealth(state: .reconnecting))

        settler.ingest(ConnectionHealth(state: .connected))

        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connected))
        XCTAssertEqual(recorder.published, [ConnectionHealth(state: .connected)])
        XCTAssertTrue(hold.requested.isEmpty, "Recovery must not wait on a hold")
    }

    
    
    func testTroubleRefinesLiveOnceItIsOnScreen() async {
        let (settler, recorder) = makeSettler(
            initial: ConnectionHealth(state: .reconnecting, reconnectAttempt: 1))

        settler.ingest(ConnectionHealth(state: .reconnecting, reconnectAttempt: 2))
        settler.ingest(ConnectionHealth(state: .gaveUp))

        XCTAssertEqual(settler.settled, ConnectionHealth(state: .gaveUp))
        XCTAssertEqual(recorder.published.count, 2)
        XCTAssertTrue(hold.requested.isEmpty, "Trouble → trouble must not wait on a hold")
    }

    
    
    func testAStallIsHeldLikeAnyOtherTrouble() async {
        let (settler, recorder) = makeSettler()

        settler.ingest(ConnectionHealth(state: .connected, isStalled: true))
        await holdParks()
        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connected))

        settler.ingest(ConnectionHealth(state: .connected, isStalled: false))
        await expireHold()

        XCTAssertTrue(recorder.published.isEmpty)
    }

    

    
    
    func testTroubleAtLaunchIsNotHeld() async {
        let (settler, recorder) = makeSettler(initial: ConnectionHealth(state: .disconnected))

        settler.ingest(ConnectionHealth(state: .connecting))

        XCTAssertEqual(settler.settled, ConnectionHealth(state: .connecting))
        XCTAssertEqual(recorder.published, [ConnectionHealth(state: .connecting)])
        XCTAssertTrue(hold.requested.isEmpty)
    }

    
    
    func testSettleImmediatelySkipsTheHold() async {
        let (settler, recorder) = makeSettler()
        let stalled = ConnectionHealth(state: .connected, isStalled: true)

        settler.settleImmediately(stalled)

        XCTAssertEqual(settler.settled, stalled)
        XCTAssertEqual(recorder.published, [stalled])
        XCTAssertTrue(hold.requested.isEmpty)
    }

    
    
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

    
    
    func testAnUnchangedReadingPublishesNothing() async {
        let (settler, recorder) = makeSettler()

        settler.ingest(ConnectionHealth(state: .connected))
        settler.settleImmediately(ConnectionHealth(state: .connected))

        XCTAssertTrue(recorder.published.isEmpty)
        XCTAssertTrue(hold.requested.isEmpty)
    }

    

    
    
    
    
    
    private func holdParks(_ expected: Int = 1) async {
        for _ in 0..<100 where hold.requested.count < expected {
            await Task.yield()
        }
        XCTAssertEqual(hold.requested.count, expected, "the hold should have started sleeping")
    }

    
    
    
    private func expireHold() async {
        for _ in 0..<100 {
            hold.release()
            await Task.yield()
        }
    }
}
