import Foundation
import SliccTrayKit
import XCTest

@testable import SliccFollower

/// Delegated sudo prompts through `AppState` (#2062): the leader message lands
/// as a pending card, `cancel` withdraws it, and the hello / push plumbing
/// behaves without a leader or an APNs token.
@MainActor
final class AppStateSudoApprovalTests: XCTestCase {
    private func send(_ message: LeaderToFollowerMessage, to state: AppState) throws {
        state.handleDataChannelMessage(try JSONEncoder().encode(message))
    }

    private func prompt(id: String = "sudo-1") -> LeaderToFollowerMessage {
        .sudoApproveRequest(
            requestId: id,
            kind: "command",
            detail: "git push origin main",
            requester: "biscotto \u{201C}Anna\u{201D}",
            suggestedPattern: "git push *",
            scoopName: "Researcher",
            expiresAt: Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)
    }

    func testSudoRequestBecomesAPendingCardAndCancelWithdrawsIt() throws {
        let state = AppState()
        try send(prompt(), to: state)
        XCTAssertEqual(state.sudoApprovals.map(\.requestId), ["sudo-1"])
        XCTAssertEqual(state.sudoApprovals.first?.scoopName, "Researcher")
        // The leader's own account of the asker reaches the card, so a guest
        // cannot be the only voice describing who they are.
        XCTAssertEqual(state.sudoApprovals.first?.requester, "biscotto \u{201C}Anna\u{201D}")
        XCTAssertEqual(state.sudoApprovals.first?.heading, "Run command?")

        try send(.sudoApproveCancel(requestId: "sudo-1"), to: state)
        XCTAssertTrue(state.sudoApprovals.isEmpty)
        // Unknown ids are harmless.
        try send(.sudoApproveCancel(requestId: "nope"), to: state)
    }

    func testExpiredPromptNeverShows() throws {
        let state = AppState()
        try send(
            .sudoApproveRequest(
                requestId: "late", kind: "write", detail: "/etc/sudoers", requester: nil,
                suggestedPattern: nil, scoopName: nil, expiresAt: 1000),
            to: state)
        XCTAssertTrue(state.sudoApprovals.isEmpty)
    }

    func testDenyDecisionDropsTheCardWithoutATransport() throws {
        let state = AppState()
        try send(prompt(), to: state)
        state.resolveSudoApproval(requestId: "sudo-1", decision: .deny)
        let settled = expectation(description: "card removed")
        Task { @MainActor in
            while !state.sudoApprovals.isEmpty { await Task.yield() }
            settled.fulfill()
        }
        wait(for: [settled], timeout: 2)
    }

    func testHelloCapabilitiesAdvertiseSudoApproval() {
        let state = AppState()
        let caps = state.followerCapabilities()
        XCTAssertTrue(caps.exec)
        XCTAssertEqual(caps.sudoApproval, true)
        // The simulator has no passcode unless configured; either way the
        // flag must mirror the device-owner policy probe.
        XCTAssertEqual(caps.biometric, AppState.deviceOwnerAuthAvailable() ? true : nil)
    }

    func testPushRegistrationIsANoOpWithoutAConnection() {
        let state = AppState()
        state.registerPushTokenIfAvailable()
        state.startPushRegistration()
        XCTAssertNotEqual(state.connectionState, .connected)
    }

    func testTurnEndNotificationIsSuppressedWhileActive() {
        let state = AppState()
        let coordinator = NotificationCoordinator.shared
        let original = coordinator.isActive
        defer { coordinator.isActive = original }
        coordinator.isActive = { true }
        state.notifyTurnEndIfBackgrounded(scoopJid: "cone")
        coordinator.isActive = { false }
        state.notifyTurnEndIfBackgrounded(scoopJid: "missing-scoop")
        coordinator.notifySudoRequest(requestId: "sudo-x", label: "SLICC", trayId: nil)
        coordinator.clearSudoNotification(requestId: "sudo-x")
    }

    func testDeviceTokenIsHexEncodedAndForwarded() {
        let coordinator = NotificationCoordinator.shared
        var forwarded: String?
        coordinator.onDeviceToken = { forwarded = $0 }
        coordinator.didRegister(deviceToken: Data([0x00, 0xab, 0xff]))
        XCTAssertEqual(coordinator.deviceToken, "00abff")
        XCTAssertEqual(forwarded, "00abff")
        coordinator.didFailToRegister(error: NSError(domain: "t", code: 1))
        coordinator.install()
        coordinator.install()
        #if DEBUG
            XCTAssertEqual(currentApnsEnvironment(), "sandbox")
        #endif
    }

    func testLockScreenDenyReachesTheController() throws {
        let state = AppState()
        state.wireNotificationActions()
        try send(prompt(id: "sudo-lock"), to: state)
        NotificationCoordinator.shared.onSudoDeny?("sudo-lock")
        XCTAssertTrue(state.sudoApprovals.isEmpty)
        NotificationCoordinator.shared.onSudoReview?("sudo-lock")
    }

    func testScoopSwipeWrapsAndFallsBackToTheCone() {
        let state = AppState()
        let cone = ScoopSummary(
            jid: "cone", name: "cone", folder: "cone", isCone: true, assistantLabel: "SLICC")
        let scoop = ScoopSummary(
            jid: "s1", name: "s1", folder: "s1", isCone: false, assistantLabel: "Researcher")
        state.scoops = [cone, scoop]
        state.selectedScoopJid = "cone"
        state.swipeToNextScoop()
        XCTAssertEqual(state.selectedScoopJid, "s1")
        state.swipeToNextScoop()
        XCTAssertEqual(state.selectedScoopJid, "cone")
        state.swipeToPreviousScoop()
        XCTAssertEqual(state.selectedScoopJid, "cone")
        state.selectedScoopJid = "s1"
        state.swipeToPreviousScoop()
        XCTAssertEqual(state.selectedScoopJid, "cone")
        state.scoops = []
        state.swipeToNextScoop()
        state.swipeToPreviousScoop()
    }
}
