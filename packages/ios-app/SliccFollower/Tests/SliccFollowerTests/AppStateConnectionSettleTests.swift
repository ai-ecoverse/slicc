import Foundation
import XCTest

@testable import SliccFollower

/// `AppState`'s half of the settle window: which property the chat surface
/// reads, and which transitions reach it when.
///
/// The hold itself is `ConnectionSettler`'s and is covered deterministically in
/// `ConnectionSettleTests`. Nothing here waits it out — every assertion lands
/// on the near side of the window, which is exactly the interesting side.
@MainActor
final class AppStateConnectionSettleTests: XCTestCase {

    /// A cold start has no healthy state to protect, so the launch state is
    /// published as-is rather than a window later.
    func testTheSettledViewStartsAtTheRawLaunchState() {
        let state = AppState()

        XCTAssertEqual(state.settledConnection, ConnectionHealth(state: .disconnected))
        XCTAssertEqual(state.rawConnectionHealth, state.settledConnection)
    }

    func testRawHealthTracksEveryTransportProperty() {
        let state = AppState()

        state.connectionState = .reconnecting
        state.reconnectAttempt = 4
        state.isLeaderStalled = true

        XCTAssertEqual(
            state.rawConnectionHealth,
            ConnectionHealth(state: .reconnecting, isStalled: true, reconnectAttempt: 4))
    }

    /// Connecting is immediate — the launch state is already trouble, and
    /// trouble → trouble refines live.
    func testReachingConnectedIsPublishedImmediately() {
        let state = AppState()

        state.connectionState = .connected

        XCTAssertEqual(state.settledConnection, ConnectionHealth(state: .connected))
        XCTAssertTrue(state.settledConnection.isHealthy)
    }

    /// The whole point: a drop from a healthy connection does not reach the UI
    /// on the same turn of the run loop that produced it.
    func testADropDoesNotReachTheSettledViewImmediately() {
        let state = AppState()
        state.connectionState = .connected

        state.connectionState = .reconnecting
        state.reconnectAttempt = 1

        XCTAssertEqual(state.connectionState, .reconnecting, "the raw state changes at once")
        XCTAssertEqual(
            state.settledConnection, ConnectionHealth(state: .connected),
            "the chat surface must still read healthy inside the hold")
    }

    /// A stall is held on the same terms as a drop — the composer must not
    /// change its story for a leader that answers the next ping.
    func testAStallDoesNotReachTheSettledViewImmediately() {
        let state = AppState()
        state.connectionState = .connected

        state.isLeaderStalled = true

        XCTAssertTrue(state.isLeaderStalled)
        XCTAssertFalse(state.settledConnection.isStalled)
    }

    /// Recovery is never held, so a connection that comes back is on screen at
    /// once rather than a window after it is demonstrably fine.
    func testRecoveryIsPublishedImmediately() {
        let state = AppState()
        state.connectionState = .connected
        state.settleConnectionImmediately()
        state.connectionState = .reconnecting
        state.settleConnectionImmediately()

        state.connectionState = .connected

        XCTAssertEqual(state.settledConnection, ConnectionHealth(state: .connected))
    }

    /// The UI-test hook path: a pinned state is a premise, not a transition.
    func testSettleImmediatelyPublishesTheRawState() {
        let state = AppState()
        state.connectionState = .connected
        state.settleConnectionImmediately()

        state.isLeaderStalled = true
        state.settleConnectionImmediately()

        XCTAssertEqual(
            state.settledConnection, ConnectionHealth(state: .connected, isStalled: true))
    }
}
