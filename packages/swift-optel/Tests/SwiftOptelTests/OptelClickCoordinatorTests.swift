import XCTest
@testable import SwiftOptel

final class OptelClickCoordinatorTests: XCTestCase {
    override func setUp() {
        super.setUp()
        OptelClickCoordinator._testing_reset()
    }

    override func tearDown() {
        OptelClickCoordinator._testing_reset()
        super.tearDown()
    }

    func testEpochsAreMonotonicallyIncreasing() {
        let first = OptelClickCoordinator.beginMonitorEvent()
        let second = OptelClickCoordinator.beginMonitorEvent()
        let third = OptelClickCoordinator.beginMonitorEvent()
        XCTAssertLessThan(first, second)
        XCTAssertLessThan(second, third)
    }

    func testClaimByRefinedMarksLatestEpochAsClaimed() {
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        OptelClickCoordinator.claimByRefined()
        XCTAssertTrue(OptelClickCoordinator.wasClaimedByRefined(epoch: epoch))
    }

    func testUnclaimedEpochReportsAsNotClaimed() {
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        XCTAssertFalse(OptelClickCoordinator.wasClaimedByRefined(epoch: epoch))
    }

    func testClaimAppliesOnlyToCurrentPendingEpoch() {
        // A refined claim only marks the most-recent pending monitor event;
        // an older monitor epoch from a prior event is NOT collapsed into the
        // same claim, so its deferred emit will still fire.
        let older = OptelClickCoordinator.beginMonitorEvent()
        _ = OptelClickCoordinator.beginMonitorEvent()
        OptelClickCoordinator.claimByRefined()
        XCTAssertFalse(OptelClickCoordinator.wasClaimedByRefined(epoch: older))
    }

    func testClaimWithoutPriorMonitorEventDoesNotPoisonFutureEpochs() {
        // A refined fire that happens with no in-flight monitor event (the
        // monitor is not installed, or the click was on `optel-ignore`) must
        // not cause the NEXT real monitor event's deferred emit to be
        // suppressed.
        OptelClickCoordinator.claimByRefined()
        let nextEpoch = OptelClickCoordinator.beginMonitorEvent()
        XCTAssertFalse(OptelClickCoordinator.wasClaimedByRefined(epoch: nextEpoch))
    }

    func testTestingResetClearsPendingAndClaim() {
        let epoch = OptelClickCoordinator.beginMonitorEvent()
        OptelClickCoordinator.claimByRefined()
        XCTAssertTrue(OptelClickCoordinator.wasClaimedByRefined(epoch: epoch))
        OptelClickCoordinator._testing_reset()
        let reset = OptelClickCoordinator.beginMonitorEvent()
        XCTAssertFalse(OptelClickCoordinator.wasClaimedByRefined(epoch: epoch))
        XCTAssertFalse(OptelClickCoordinator.wasClaimedByRefined(epoch: reset))
    }
}
