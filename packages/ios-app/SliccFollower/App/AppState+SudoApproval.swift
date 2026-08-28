import Foundation
import LocalAuthentication
import SliccTrayKit
import UIKit

// MARK: - Delegated sudo approval (#2062)
//
// The leader hands a sudo prompt to this phone when its human is here or it
// has no human at all. The controller (SliccTrayKit) owns the queue and the
// reply; this extension supplies the Face ID gate, the notification hooks,
// and the push-token registration.

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

    /// `sudo.approve.request` / `.cancel` from the leader (dispatch lives here
    /// so the size-capped `AppState` switch stays a one-liner).
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

    /// What this phone advertises on `hello`: `biometric` iff the device can
    /// authenticate its owner right now.
    func followerCapabilities() -> TraySyncCapabilities {
        makeTrayFollowerCapabilities(deviceOwnerAuth: Self.deviceOwnerAuthAvailable())
    }

    /// On connect: ask for notification permission once, then register the
    /// APNs token with this leader's tray (#2062).
    func startPushRegistration() {
        NotificationCoordinator.shared.requestAuthorizationAndRegister()
        registerPushTokenIfAvailable()
    }

    /// Card button → controller. Allow / Always go through Face ID inside.
    func resolveSudoApproval(requestId: String, decision: SudoApprovalDecision) {
        Task { @MainActor [weak self] in
            await self?.sudoApprovalController.resolve(requestId: requestId, decision: decision)
        }
    }

    /// Lock-screen actions and token arrivals from the notification layer.
    func wireNotificationActions() {
        let notifications = NotificationCoordinator.shared
        notifications.onSudoDeny = { [weak self] requestId in
            self?.sudoApprovalController.denyFromNotification(requestId: requestId)
        }
        // "Review…" foregrounds the app; the card is already on screen (or the
        // reconnect brings it back). Nothing else to do.
        notifications.onSudoReview = { _ in }
        notifications.onDeviceToken = { [weak self] _ in
            self?.registerPushTokenIfAvailable()
        }
    }

    /// Send `push.register` for the current token, if iOS has issued one and
    /// the leader is connected. Re-sent on every connect because the tray
    /// (and so its token store) can change between sessions.
    func registerPushTokenIfAvailable() {
        guard connectionState == .connected,
            let token = NotificationCoordinator.shared.deviceToken
        else { return }
        _ = sendToLeader(
            .pushRegister(platform: "ios", token: token, environment: currentApnsEnvironment()))
    }

    /// A turn landed while the app is not on screen: local banner, so the
    /// data-channel path works even without APNs (simulator, denied push).
    func notifyTurnEndIfBackgrounded(scoopJid: String) {
        let label = scoops.first(where: { $0.jid == scoopJid })?.assistantLabel ?? activeDisplayName ?? "SLICC"
        NotificationCoordinator.shared.notifyTurnEnd(label: label, trayId: trayId)
    }

    /// Can this device authenticate its owner (Face ID / Touch ID / passcode)?
    /// Decides the `biometric` capability and whether the card offers "Always".
    static func deviceOwnerAuthAvailable() -> Bool {
        #if DEBUG
            if UITestHooks.stagesSudoApprovalFixture { return true }
        #endif
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// The gate. `.deviceOwnerAuthentication` tries biometrics first and falls
    /// back to the passcode; the attestation reports which one succeeded.
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
        /// Seed a pending sudo card for the UI test (`-uiTestSudoApproval YES`).
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
