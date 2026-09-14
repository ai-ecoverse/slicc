import Foundation
import XCTest

@testable import SliccFollower







@MainActor
final class AppStateConnectionSettleTests: XCTestCase {

    
    
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

    
    
    func testReachingConnectedIsPublishedImmediately() {
        let state = AppState()

        state.connectionState = .connected

        XCTAssertEqual(state.settledConnection, ConnectionHealth(state: .connected))
        XCTAssertTrue(state.settledConnection.isHealthy)
    }

    
    
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

    
    
    func testAStallDoesNotReachTheSettledViewImmediately() {
        let state = AppState()
        state.connectionState = .connected

        state.isLeaderStalled = true

        XCTAssertTrue(state.isLeaderStalled)
        XCTAssertFalse(state.settledConnection.isStalled)
    }

    
    
    func testRecoveryIsPublishedImmediately() {
        let state = AppState()
        state.connectionState = .connected
        state.settleConnectionImmediately()
        state.connectionState = .reconnecting
        state.settleConnectionImmediately()

        state.connectionState = .connected

        XCTAssertEqual(state.settledConnection, ConnectionHealth(state: .connected))
    }

    

    
    
    
    
    
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

    
    func testDisconnectingFromAStallStaysTrouble() {
        let state = AppState()
        state.connectionState = .connected
        state.isLeaderStalled = true
        state.settleConnectionImmediately()

        state.disconnect()

        XCTAssertEqual(state.connectionState, .disconnected)
        XCTAssertFalse(state.settledConnection.isHealthy)
    }

    
    
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
