import Foundation
import LocalAuthentication
import SliccTrayKit
import UIKit

extension AppState {
    func makeSudoApprovalController() -> SudoApprovalController {
        var send: (FollowerToLeaderMessage) -> Bool = { [weak self] in
            self?.sendToLeader($0) ?? false
        }
        var authenticate: SudoAuthenticator = { reason in
            await AppState.authenticateDeviceOwner(reason: reason)
        }
        #if DEBUG
            if UITestHooks.stagesSudoApprovalFixture {
                send = { _ in true }
                authenticate = { _ in .authenticated(.biometric) }
            }
        #endif
        let notifications = NotificationCoordinator.shared
        return SudoApprovalController(
            send: send,
            authenticate: authenticate,
            onPendingChanged: { [weak self] in self?.sudoApprovals = $0 },
            onArrived: { [weak self] request in
                notifications.notifySudoRequest(
                    requestId: request.requestId,
                    label: request.scoopName ?? self?.activeDisplayName ?? "SLICC",
                    trayId: self?.trayId)
            },
            onWithdrawn: { requestId in
                notifications.clearSudoNotification(requestId: requestId)
            })
    }

    func handleSudoLeaderMessage(_ message: LeaderToFollowerMessage) {
        switch message {
        case .sudoApproveRequest(
            let requestId, let kind, let detail, let requester, let suggestedPattern,
            let scoopName, let expiresAt):
            sudoApprovalController.handle(
                requestId: requestId,
                kind: kind,
                detail: detail,
                requester: requester,
                suggestedPattern: suggestedPattern,
                scoopName: scoopName,
                expiresAt: Date(timeIntervalSince1970: expiresAt / 1000))
        case .sudoApproveCancel(let requestId):
            sudoApprovalController.cancel(requestId: requestId)
        default:
            break
        }
    }

    func followerCapabilities() -> TraySyncCapabilities {
        makeTrayFollowerCapabilities(deviceOwnerAuth: Self.deviceOwnerAuthAvailable())
    }

    func startPushRegistration() {
        NotificationCoordinator.shared.requestAuthorizationAndRegister()
        registerPushTokenIfAvailable()
    }

    func resolveSudoApproval(requestId: String, decision: SudoApprovalDecision) {
        Task { @MainActor [weak self] in
            await self?.sudoApprovalController.resolve(requestId: requestId, decision: decision)
        }
    }

    func wireNotificationActions() {
        let notifications = NotificationCoordinator.shared
        notifications.onSudoDeny = { [weak self] requestId in
            self?.sudoApprovalController.denyFromNotification(requestId: requestId)
        }

        notifications.onSudoReview = { _ in }
        notifications.onDeviceToken = { [weak self] _ in
            self?.registerPushTokenIfAvailable()
        }
    }

    func registerPushTokenIfAvailable() {
        guard connectionState == .connected,
            let token = NotificationCoordinator.shared.deviceToken
        else { return }
        _ = sendToLeader(
            .pushRegister(platform: "ios", token: token, environment: currentApnsEnvironment()))
    }

    func notifyTurnEndIfBackgrounded(scoopJid: String) {
        let label = scoops.first(where: { $0.jid == scoopJid })?.assistantLabel ?? activeDisplayName ?? "SLICC"
        NotificationCoordinator.shared.notifyTurnEnd(label: label, trayId: trayId)
    }

    static func deviceOwnerAuthAvailable() -> Bool {
        #if DEBUG
            if UITestHooks.stagesSudoApprovalFixture { return true }
        #endif
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    static func authenticateDeviceOwner(reason: String) async -> SudoAuthOutcome {
        let context = LAContext()
        context.localizedCancelTitle = "Deny"
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
            return .refused
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            guard ok else { return .refused }
            let biometric =
                context.biometryType != .none
                && context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
            return .authenticated(biometric ? .biometric : .passcode)
        } catch {
            return .refused
        }
    }

    #if DEBUG

        func configureSudoApprovalFixture() {
            guard UITestHooks.stagesSudoApprovalFixture else { return }
            connectionState = .connected
            sudoApprovalController.handle(
                requestId: "ui-sudo-approval",
                kind: "command",
                detail: "git push origin main",
                suggestedPattern: "git push *",
                scoopName: "Fixture scoop",
                expiresAt: Date().addingTimeInterval(300))
        }
    #endif
}
