import Foundation
import SliccTrayKit
import UIKit

// MARK: - Approval-gated exec routing

extension AppState {
    func handleExecMessage(_ message: LeaderToFollowerMessage) {
        handleApprovalGatedExecMessage(
            message,
            requesterIdentity: activeDisplayName ?? "Connected Sliccy leader",
            sessionIdentity: trayId ?? "Current tray")
    }

    func makeOpenApprovalController() -> OpenApprovalController {
        var send: (FollowerToLeaderMessage) -> Bool = { [weak self] in
            self?.sendToLeader($0) ?? false
        }
        #if DEBUG
            // No leader answers the fixture, and a send failure would settle
            // the request as unavailable before the card ever renders.
            if UITestHooks.stagesOpenApprovalFixture { send = { _ in true } }
        #endif
        return OpenApprovalController(
            grantStore: openGrantStore,
            send: send,
            launch: { [weak self] request in self?.launchApprovedOpen(request) },
            onApprovalsChanged: { [weak self] in self?.openApprovals = $0 },
            onGrantsChanged: { [weak self] in self?.openGrants = $0 })
    }

    func handleOpenCallback(_ url: URL) -> Bool {
        openApprovalController.handleCallbackURL(url)
    }

    func resolveOpenApproval(requestId: String, decision: OpenApprovalDecision) {
        openApprovalController.resolve(requestId: requestId, decision: decision)
    }

    func revokeOpenGrant(id: UUID) {
        openApprovalController.revokeGrant(id: id)
    }

    func revokeAllOpenGrants() {
        openApprovalController.revokeAllGrants()
    }

    func handleApprovalGatedExecMessage(
        _ message: LeaderToFollowerMessage,
        requesterIdentity: String,
        sessionIdentity: String
    ) {
        switch message {
        case .execRequest(let requestId, let command, _, _, _):
            openApprovalController.handle(
                requestId: requestId,
                command: command,
                requesterIdentity: requesterIdentity,
                sessionIdentity: sessionIdentity)
        case .execChunk(let requestId, let stream, let data):
            terminalClient.handleChunk(
                requestId: requestId, stream: stream, base64Data: data)
        case .execResponse(let requestId, let exitCode, let signal, let error):
            terminalClient.handleResponse(
                requestId: requestId, exitCode: exitCode, signal: signal, error: error)
        case .execSignal(let requestId, let signal):
            openApprovalController.cancel(requestId: requestId, signal: signal)
        default:
            return
        }
    }

    private func launchApprovedOpen(_ request: OpenLaunchRequest) {
        let options: [UIApplication.OpenExternalURLOptionsKey: Any] =
            request.mode == .universal ? [.universalLinksOnly: true] : [:]
        UIApplication.shared.open(request.url, options: options) { [weak self] opened in
            Task { @MainActor [weak self] in
                self?.openApprovalController.completeLaunch(
                    requestId: request.requestId, opened: opened)
            }
        }
    }

    #if DEBUG
        /// Enters through `handle` so the controller owns the request: a UI
        /// test tapping Deny / Allow once / Always allow settles real state
        /// instead of hitting an approval the controller never saw.
        func configureOpenApprovalFixture() {
            guard let fixture = UITestHooks.openApprovalFixture() else { return }
            connectionState = .connected
            openApprovalController.handle(
                requestId: fixture.requestId,
                command: fixture.command,
                requesterIdentity: fixture.requesterIdentity,
                sessionIdentity: fixture.sessionIdentity)
        }
    #endif
}
