import Foundation
import SliccTrayFollower
import XCTest

@testable import Sliccstart




@MainActor
final class HeadlessComputerFollowTests: XCTestCase {
    private var lines: [String] = []
    private var exits: [Int32] = []
    private var connector = RecordingConnector()

    override func setUp() async throws {
        lines = []
        exits = []
        connector = RecordingConnector()
    }

    private func makeSession() -> (HeadlessComputerFollow, ComputerTrayFollower) {
        let connector = self.connector
        let follower = ComputerTrayFollower(
            makeConnector: { _ in connector },
            makeCapturer: { StubCapturer() },
            permissions: ComputerPermissions(probe: .alwaysGranted),
            eventSink: RecordingEventSink(),
            pairId: "pair-test")
        let session = HeadlessComputerFollow(
            follower: follower,
            emit: { [weak self] in self?.lines.append($0) },
            terminate: { [weak self] in self?.exits.append($0) })
        return (session, follower)
    }

    private func openChannel(_ follower: ComputerTrayFollower) {
        follower.connector(
            TrayFollowerConnector(joinUrl: URL(string: "https://tray.test/join/x")!),
            didConnect: { _ in true })
    }

    
    
    private func drain() async {
        await Task.yield()
        await Task.yield()
    }

    func testReadyIsPrintedBeforeAnyNetworkWork() async {
        let (session, follower) = makeSession()
        session.start(joinUrl: "https://tray.test/join/x")
        XCTAssertEqual(lines, [ComputerFollowCLI.readyLine])
        await follower._testing_settle()
        XCTAssertEqual(connector.started, 1, "start must actually dial the leader")
        XCTAssertEqual(lines, [ComputerFollowCLI.readyLine], "dialling alone is not attached")
        XCTAssertEqual(exits, [])
    }

    func testAttachedIsReportedOnceWhenTheChannelOpens() async {
        let (session, follower) = makeSession()
        session.start(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()

        openChannel(follower)
        await drain()
        openChannel(follower)  
        await drain()

        XCTAssertEqual(lines, [ComputerFollowCLI.readyLine, ComputerFollowCLI.attachedLine])
        XCTAssertEqual(exits, [])
    }

    
    
    func testAFailedFirstAttachReportsTheReasonAndExits() async {
        connector.startError = URLError(.cannotFindHost)
        let (session, follower) = makeSession()
        session.start(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()

        XCTAssertEqual(lines.first, ComputerFollowCLI.readyLine)
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(
            lines[1].hasPrefix(ComputerFollowCLI.failedPrefix + " "),
            "second line should be a FAILED line with a reason: \(lines)")
        XCTAssertFalse(lines.contains(ComputerFollowCLI.attachedLine))
        XCTAssertEqual(exits, [1])
    }

    func testGivingUpAfterAttachingStopsTheFollowerAndExits() async {
        let (session, follower) = makeSession()
        session.start(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()
        openChannel(follower)
        await drain()

        follower.connector(
            TrayFollowerConnector(joinUrl: URL(string: "https://tray.test/join/x")!),
            didGiveUp: "ICE failed")
        await drain()

        XCTAssertEqual(lines.last, "\(ComputerFollowCLI.failedPrefix) ICE failed")
        XCTAssertEqual(exits, [1])
        XCTAssertGreaterThanOrEqual(connector.stopped, 1, "the follower must be torn down first")
    }

    
    
    func testTheParentExitingStopsTheFollowerAndExitsCleanly() async {
        let (session, follower) = makeSession()
        session.start(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()

        session.parentExited()

        XCTAssertEqual(exits, [0])
        XCTAssertGreaterThanOrEqual(connector.stopped, 1)
    }

    func testASignalStopsTheFollowerAndExitsCleanly() async {
        let (session, follower) = makeSession()
        session.start(joinUrl: "https://tray.test/join/x")
        await follower._testing_settle()

        session.signalled()

        XCTAssertEqual(exits, [0])
        XCTAssertGreaterThanOrEqual(connector.stopped, 1)
    }
}
