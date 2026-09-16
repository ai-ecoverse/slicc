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

        let older = OptelClickCoordinator.beginMonitorEvent()
        _ = OptelClickCoordinator.beginMonitorEvent()
        OptelClickCoordinator.claimByRefined()
        XCTAssertFalse(OptelClickCoordinator.wasClaimedByRefined(epoch: older))
    }

    func testClaimWithoutPriorMonitorEventDoesNotPoisonFutureEpochs() {

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
