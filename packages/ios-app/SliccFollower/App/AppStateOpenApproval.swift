import Foundation
import SliccTrayKit

// MARK: - Approval-gated exec routing

extension AppState {
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
        case .execRequest(let requestId, let command, _, _):
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
}
