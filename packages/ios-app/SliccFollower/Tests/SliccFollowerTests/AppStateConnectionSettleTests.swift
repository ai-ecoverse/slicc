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

    // MARK: - Composite transitions

    /// A stalled leader that finally dies goes trouble → trouble, and the
    /// treatment must never blink off on the way. `handleDisconnect` clears
    /// the stall and moves the state, and either write alone reads as a
    /// healthy connection — which would drop the static eyes and then hold the
    /// disconnect for a whole window.
    func testAStallThatBecomesADisconnectStaysTrouble() {
        let state = AppState()
        state.connectionState = .connected
        state.isLeaderStalled = true
        state.settleConnectionImmediately()
        XCTAssertFalse(state.settledConnection.isHealthy, "precondition: the stall is on screen")

        state.handleDisconnect(reason: "keepalive gave up")

        XCTAssertEqual(state.connectionState, .reconnecting)
        XCTAssertFalse(
            state.settledConnection.isHealthy,
            "A stall that became a disconnect must not read as a recovery")
    }

    /// The same for a user-initiated disconnect from a stalled session.
    func testDisconnectingFromAStallStaysTrouble() {
        let state = AppState()
        state.connectionState = .connected
        state.isLeaderStalled = true
        state.settleConnectionImmediately()

        state.disconnect()

        XCTAssertEqual(state.connectionState, .disconnected)
        XCTAssertFalse(state.settledConnection.isHealthy)
    }

    /// The general guarantee behind both: a batch is weighed once, on the
    /// value it ends at, never on an intermediate it passed through.
    func testUpdateConnectionIngestsOnlyTheFinalReading() {
        let state = AppState()
        state.connectionState = .connected
        state.isLeaderStalled = true
        state.settleConnectionImmediately()

        state.updateConnection {
            state.isLeaderStalled = false
            state.connectionState = .failed
        }

        XCTAssertEqual(
            state.settledConnection, ConnectionHealth(state: .failed),
            "trouble → trouble publishes at once; the healthy intermediate never existed")
    }

    /// A batch that really does end healthy still publishes the recovery.
    func testUpdateConnectionStillPublishesAGenuineRecovery() {
        let state = AppState()
        state.connectionState = .reconnecting
        state.reconnectAttempt = 2
        state.settleConnectionImmediately()

        state.updateConnection {
            state.reconnectAttempt = 0
            state.connectionState = .connected
        }

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
