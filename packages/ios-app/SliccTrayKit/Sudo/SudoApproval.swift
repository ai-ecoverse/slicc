import Foundation

// MARK: - Delegated sudo approval (issue #2062)
//
// The leader delegates a sudo prompt to this phone when its human is here (or
// it has no human at all — the hosted/cloud float). The controller below owns
// the pending cards, the Face ID / passcode gate in front of Allow and Always,
// and the fail-closed reply. It is UI-free and clock-injected so the XCTest
// target can drive it without a leader or a biometric sensor.

/// One prompt the leader wants this phone's human to answer.
public struct SudoApprovalRequest: Identifiable, Equatable, Sendable {
    public let requestId: String
    /// `command` / `read` / `write` / `secret` / `export` — mirrors `TraySudoKind`.
    public let kind: String
    /// The concrete command line, VFS path, secret name, or export subject.
    /// May be attacker-authored prose for the `guest-message` / `guest-tool`
    /// kinds, which is why `requester` is carried separately.
    public let detail: String
    /// The LEADER's account of who is asking — never the requester's own.
    /// Rendered as card chrome above `detail`.
    public let requester: String?
    /// The editable default for an "Always" grant.
    public let suggestedPattern: String?
    /// Requesting scoop's label, when the action came from a scoop.
    public let scoopName: String?
    /// When the leader gives up and denies; the card disappears then.
    public let expiresAt: Date
    /// When this phone received it (drives the countdown).
    public let receivedAt: Date

    public var id: String { requestId }

    public init(
        requestId: String,
        kind: String,
        detail: String,
        requester: String? = nil,
        suggestedPattern: String?,
        scoopName: String?,
        expiresAt: Date,
        receivedAt: Date
    ) {
        self.requestId = requestId
        self.kind = kind
        self.detail = detail
        self.requester = requester
        self.suggestedPattern = suggestedPattern
        self.scoopName = scoopName
        self.expiresAt = expiresAt
        self.receivedAt = receivedAt
    }

    /// The pattern an "Always" grant starts from.
    public var defaultPattern: String {
        let trimmed = suggestedPattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? detail : trimmed
    }

    /// Human heading per kind.
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

    /// What the detail row is labelled per kind.
    public var detailLabel: String {
        switch kind {
        case "command": return "Command"
        case "read", "write": return "Path"
        case "secret": return "Secret"
        case "export": return "Transcript"
        default: return "Detail"
        }
    }

    /// Export subjects read as sessions, everything else verbatim.
    public var displayDetail: String {
        guard kind == "export" else { return detail }
        if detail == "active" { return "Active session" }
        if detail.hasPrefix("frozen:") {
            return "Archived session (\(detail.dropFirst("frozen:".count)))"
        }
        return detail
    }
}

/// The human's answer on the card.
public enum SudoApprovalDecision: Equatable, Sendable {
    case allowOnce
    /// `pattern` is the (possibly edited) glob to persist; empty falls back to the suggestion.
    case always(pattern: String)
    case deny
}

/// Which gate the human passed. Mirrors `TraySudoAttestation` on the wire.
public enum SudoAttestation: String, Sendable {
    case biometric
    case passcode
    case none
}

/// Outcome of the device-owner authentication gate.
public enum SudoAuthOutcome: Equatable, Sendable {
    case authenticated(SudoAttestation)
    /// The user cancelled, failed, or the policy is unavailable — all deny.
    case refused
}

/// Seam over `LAContext`: given a reason string, authenticate the device owner.
public typealias SudoAuthenticator = @Sendable (String) async -> SudoAuthOutcome

/// Pending-card owner + reply path for delegated sudo prompts.
@MainActor
public final class SudoApprovalController {
    /// Leader-side wire decision strings.
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

    /// - Parameters:
    ///   - send: Wire sink; `false` when the transport is gone.
    ///   - authenticate: The Face ID / passcode gate. Allow and Always never
    ///     skip it; Deny never invokes it.
    ///   - onArrived: A new prompt landed (post the priority notification).
    ///   - onWithdrawn: A prompt left the queue before the human answered
    ///     (clear its notification).
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

    /// A `sudo.approve.request` arrived. Duplicates refresh nothing; expired
    /// prompts are dropped on the floor (the leader already denied).
    public func handle(
        requestId: String,
        kind: String,
        detail: String,
        requester: String? = nil,
        suggestedPattern: String?,
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

    /// The leader withdrew the prompt (someone else answered, or it timed out).
    public func cancel(requestId: String) {
        guard remove(requestId: requestId) != nil else { return }
        onWithdrawn(requestId)
    }

    /// Every pending prompt dies with the transport: the leader denies on
    /// disconnect, so a later Allow here would land nowhere.
    public func transportLost() {
        for request in pending {
            onWithdrawn(request.requestId)
        }
        for task in expiryTasks.values { task.cancel() }
        expiryTasks.removeAll()
        inFlight.removeAll()
        pending.removeAll()
    }

    /// Answer a prompt. Allow / Always run the device-owner gate first; a
    /// refused gate is a deny. Replies exactly once per request.
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

    /// Deny straight from a notification action — no gate, no card needed.
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
