import Foundation










public struct SudoApprovalRequest: Identifiable, Equatable, Sendable {
    public let requestId: String
    
    public let kind: String
    
    
    
    public let detail: String
    
    
    public let requester: String?
    
    public let suggestedPattern: String?
    
    
    public let reason: String?
    
    public let scoopName: String?
    
    public let expiresAt: Date
    
    public let receivedAt: Date

    public var id: String { requestId }

    public init(
        requestId: String,
        kind: String,
        detail: String,
        requester: String? = nil,
        suggestedPattern: String?,
        reason: String? = nil,
        scoopName: String?,
        expiresAt: Date,
        receivedAt: Date
    ) {
        self.requestId = requestId
        self.kind = kind
        self.detail = detail
        self.requester = requester
        self.suggestedPattern = suggestedPattern
        self.reason = reason
        self.scoopName = scoopName
        self.expiresAt = expiresAt
        self.receivedAt = receivedAt
    }

    
    public var defaultPattern: String {
        let trimmed = suggestedPattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? detail : trimmed
    }

    
    public var heading: String {
        switch kind {
        case "command": return "Run command?"
        case "read": return "Allow read?"
        case "write": return "Allow write?"
        case "secret": return "Allow secret access?"
        case "export": return "Export transcript?"
        default: return "Approve action?"
        }
    }

    
    public var detailLabel: String {
        switch kind {
        case "command": return "Command"
        case "read", "write": return "Path"
        case "secret": return "Secret"
        case "export": return "Transcript"
        default: return "Detail"
        }
    }

    
    public var displayDetail: String {
        guard kind == "export" else { return detail }
        if detail == "active" { return "Active session" }
        if detail.hasPrefix("frozen:") {
            return "Archived session (\(detail.dropFirst("frozen:".count)))"
        }
        return detail
    }
}


public enum SudoApprovalDecision: Equatable, Sendable {
    case allowOnce
    
    case always(pattern: String)
    case deny
}


public enum SudoAttestation: String, Sendable {
    case biometric
    case passcode
    case none
}


public enum SudoAuthOutcome: Equatable, Sendable {
    case authenticated(SudoAttestation)
    
    case refused
}


public typealias SudoAuthenticator = @Sendable (String) async -> SudoAuthOutcome


@MainActor
public final class SudoApprovalController {
    
    enum WireDecision: String {
        case allow, always, deny
    }

    private let send: (FollowerToLeaderMessage) -> Bool
    private let authenticate: SudoAuthenticator
    private let now: () -> Date
    private let onPendingChanged: ([SudoApprovalRequest]) -> Void
    private let onArrived: (SudoApprovalRequest) -> Void
    private let onWithdrawn: (String) -> Void
    private var expiryTasks: [String: Task<Void, Never>] = [:]
    private var inFlight: Set<String> = []

    public private(set) var pending: [SudoApprovalRequest] = [] {
        didSet { onPendingChanged(pending) }
    }

    
    
    
    
    
    
    
    public init(
        send: @escaping (FollowerToLeaderMessage) -> Bool,
        authenticate: @escaping SudoAuthenticator,
        now: @escaping () -> Date = Date.init,
        onPendingChanged: @escaping ([SudoApprovalRequest]) -> Void = { _ in },
        onArrived: @escaping (SudoApprovalRequest) -> Void = { _ in },
        onWithdrawn: @escaping (String) -> Void = { _ in }
    ) {
        self.send = send
        self.authenticate = authenticate
        self.now = now
        self.onPendingChanged = onPendingChanged
        self.onArrived = onArrived
        self.onWithdrawn = onWithdrawn
    }

    
    
    public func handle(
        requestId: String,
        kind: String,
        detail: String,
        requester: String? = nil,
        suggestedPattern: String?,
        reason: String? = nil,
        scoopName: String?,
        expiresAt: Date
    ) {
        guard !pending.contains(where: { $0.requestId == requestId }) else { return }
        let current = now()
        guard expiresAt > current else { return }
        let request = SudoApprovalRequest(
            requestId: requestId,
            kind: kind,
            detail: detail,
            requester: requester,
            suggestedPattern: suggestedPattern,
            reason: reason,
            scoopName: scoopName,
            expiresAt: expiresAt,
            receivedAt: current)
        pending.append(request)
        onArrived(request)
        let delay = expiresAt.timeIntervalSince(current)
        expiryTasks[requestId] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.expire(requestId: requestId) }
        }
    }

    
    public func cancel(requestId: String) {
        guard remove(requestId: requestId) != nil else { return }
        onWithdrawn(requestId)
    }

    
    
    public func transportLost() {
        for request in pending {
            onWithdrawn(request.requestId)
        }
        for task in expiryTasks.values { task.cancel() }
        expiryTasks.removeAll()
        inFlight.removeAll()
        pending.removeAll()
    }

    
    
    public func resolve(requestId: String, decision: SudoApprovalDecision) async {
        guard let request = pending.first(where: { $0.requestId == requestId }),
            !inFlight.contains(requestId)
        else { return }
        inFlight.insert(requestId)
        defer { inFlight.remove(requestId) }

        switch decision {
        case .deny:
            reply(requestId: requestId, decision: .deny, pattern: nil, attestation: nil)
        case .allowOnce:
            switch await authenticate(Self.authReason(for: request)) {
            case .authenticated(let attestation):
                reply(requestId: requestId, decision: .allow, pattern: nil, attestation: attestation)
            case .refused:
                reply(requestId: requestId, decision: .deny, pattern: nil, attestation: nil)
            }
        case .always(let pattern):
            switch await authenticate(Self.authReason(for: request, always: true)) {
            case .authenticated(let attestation):
                let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
                reply(
                    requestId: requestId,
                    decision: .always,
                    pattern: trimmed.isEmpty ? request.defaultPattern : trimmed,
                    attestation: attestation)
            case .refused:
                reply(requestId: requestId, decision: .deny, pattern: nil, attestation: nil)
            }
        }
    }

    
    public func denyFromNotification(requestId: String) {
        guard pending.contains(where: { $0.requestId == requestId }) else { return }
        reply(requestId: requestId, decision: .deny, pattern: nil, attestation: nil)
    }

    static func authReason(for request: SudoApprovalRequest, always: Bool = false) -> String {
        let subject = request.kind == "export" ? request.displayDetail : request.detail
        let verb = always ? "Always allow" : "Allow"
        return "\(verb) \(request.kind): \(subject)"
    }

    private func reply(
        requestId: String,
        decision: WireDecision,
        pattern: String?,
        attestation: SudoAttestation?
    ) {
        guard remove(requestId: requestId) != nil else { return }
        onWithdrawn(requestId)
        _ = send(
            .sudoApproveResponse(
                requestId: requestId,
                decision: decision.rawValue,
                pattern: pattern,
                attestation: attestation?.rawValue))
    }

    private func expire(requestId: String) {
        guard remove(requestId: requestId) != nil else { return }
        onWithdrawn(requestId)
    }

    @discardableResult
    private func remove(requestId: String) -> SudoApprovalRequest? {
        expiryTasks.removeValue(forKey: requestId)?.cancel()
        guard let idx = pending.firstIndex(where: { $0.requestId == requestId }) else { return nil }
        return pending.remove(at: idx)
    }
}
