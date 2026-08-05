import Foundation

public struct OpenGrant: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let scope: OpenGrantScope
    public let createdAt: Date
}

public final class OpenGrantStore {
    private let defaults: UserDefaults?
    private let storageKey: String
    private let now: () -> Date
    private var stored: [OpenGrant]

    public init(
        defaults: UserDefaults? = .standard,
        storageKey: String = "slicc.open-grants.v1",
        now: @escaping () -> Date = Date.init
    ) {
        self.defaults = defaults
        self.storageKey = storageKey
        self.now = now
        if let data = defaults?.data(forKey: storageKey),
            let decoded = try? JSONDecoder().decode([OpenGrant].self, from: data)
        {
            stored = decoded
        } else {
            stored = []
        }
    }

    public var grants: [OpenGrant] {
        stored.sorted { $0.createdAt < $1.createdAt }
    }

    public func contains(_ scope: OpenGrantScope) -> Bool {
        stored.contains { $0.scope == scope }
    }

    @discardableResult
    public func grant(_ scope: OpenGrantScope) -> OpenGrant {
        if let existing = stored.first(where: { $0.scope == scope }) { return existing }
        let grant = OpenGrant(id: UUID(), scope: scope, createdAt: now())
        stored.append(grant)
        persist()
        return grant
    }

    public func revoke(id: UUID) {
        stored.removeAll { $0.id == id }
        persist()
    }

    public func revokeAll() {
        stored.removeAll()
        defaults?.removeObject(forKey: storageKey)
    }

    private func persist() {
        guard !stored.isEmpty else {
            defaults?.removeObject(forKey: storageKey)
            return
        }
        guard let data = try? JSONEncoder().encode(stored) else { return }
        defaults?.set(data, forKey: storageKey)
    }
}

public struct OpenApprovalRequest: Equatable, Identifiable, Sendable {
    public let requestId: String
    public let command: ParsedOpenCommand
    public let requesterIdentity: String
    public let sessionIdentity: String
    public var id: String { requestId }

    public init(
        requestId: String,
        command: ParsedOpenCommand,
        requesterIdentity: String,
        sessionIdentity: String
    ) {
        self.requestId = requestId
        self.command = command
        self.requesterIdentity = requesterIdentity
        self.sessionIdentity = sessionIdentity
    }
}

public final class OpenRequestStore {
    /// Recent request IDs remain tombstoned across reconnects. FIFO eviction
    /// bounds process-lifetime replay state while protecting the latest 1,024 IDs.
    public static let defaultTombstoneLimit = 1_024

    private struct Entry {
        let request: OpenApprovalRequest
        let expiresAt: Date
        let sequence: Int
    }

    private var entries: [String: Entry] = [:]
    private var seenRequestIds: Set<String> = []
    private var seenRequestOrder: [String] = []
    private var nextSequence = 0
    private let tombstoneLimit: Int

    public init(tombstoneLimit: Int = OpenRequestStore.defaultTombstoneLimit) {
        precondition(tombstoneLimit > 0, "request tombstone limit must be positive")
        self.tombstoneLimit = tombstoneLimit
    }

    public var pending: [OpenApprovalRequest] {
        entries.values.sorted { $0.sequence < $1.sequence }.map(\.request)
    }

    public func claim(requestId: String) -> Bool {
        guard entries[requestId] == nil, seenRequestIds.insert(requestId).inserted else {
            return false
        }
        seenRequestOrder.append(requestId)
        if seenRequestOrder.count > tombstoneLimit {
            seenRequestIds.remove(seenRequestOrder.removeFirst())
        }
        return true
    }

    public func insertClaimed(_ request: OpenApprovalRequest, expiresAt: Date) {
        precondition(seenRequestIds.contains(request.requestId), "request ID must be claimed")
        entries[request.requestId] = Entry(
            request: request, expiresAt: expiresAt, sequence: nextSequence)
        nextSequence += 1
    }

    public func request(id: String) -> OpenApprovalRequest? {
        entries[id]?.request
    }

    /// Removes and returns a live request. A second settlement is a no-op.
    public func settle(id: String) -> OpenApprovalRequest? {
        entries.removeValue(forKey: id)?.request
    }

    public func isExpired(id: String, at date: Date) -> Bool {
        guard let entry = entries[id] else { return false }
        return entry.expiresAt <= date
    }

    public func clearPending() {
        entries.removeAll()
        nextSequence = 0
    }
}

public enum OpenApprovalDecision: Sendable {
    case deny
    case allowOnce
    case alwaysAllow
}

public enum OpenApprovalLimits {
    public static let pendingResponses = 128
}

@MainActor
public final class OpenApprovalController {
    public static let defaultTimeout: TimeInterval = 120
    public static let waitingProgress = "Waiting for approval on iPhone…\n"
    /// Failed terminal responses are retried FIFO on reconnect. The cap avoids
    /// retaining an unbounded number of abandoned leader requests; on overflow,
    /// the oldest response is evicted for the newest terminal result.

    private let grantStore: OpenGrantStore
    private let requestStore: OpenRequestStore
    private let timeout: TimeInterval
    private let now: () -> Date
    private let sleep: @Sendable (UInt64) async throws -> Void
    private let send: (FollowerToLeaderMessage) -> Bool
    private let onApprovalsChanged: ([OpenApprovalRequest]) -> Void
    private let onGrantsChanged: ([OpenGrant]) -> Void
    private var timeoutTasks: [String: Task<Void, Never>] = [:]
    private var pendingResponses: [FollowerToLeaderMessage] = []
    private let pendingResponseLimit: Int

    public init(
        grantStore: OpenGrantStore,
        requestStore: OpenRequestStore = OpenRequestStore(),
        timeout: TimeInterval = 120,
        pendingResponseLimit: Int = OpenApprovalLimits.pendingResponses,
        now: @escaping () -> Date = Date.init,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = {
            try await Task.sleep(nanoseconds: $0)
        },
        send: @escaping (FollowerToLeaderMessage) -> Bool,
        onApprovalsChanged: @escaping ([OpenApprovalRequest]) -> Void = { _ in },
        onGrantsChanged: @escaping ([OpenGrant]) -> Void = { _ in }
    ) {
        precondition(timeout > 0, "approval timeout must be positive")
        precondition(pendingResponseLimit > 0, "pending response limit must be positive")
        self.grantStore = grantStore
        self.requestStore = requestStore
        self.timeout = timeout
        self.pendingResponseLimit = pendingResponseLimit
        self.now = now
        self.sleep = sleep
        self.send = send
        self.onApprovalsChanged = onApprovalsChanged
        self.onGrantsChanged = onGrantsChanged
    }

    public var pendingApprovals: [OpenApprovalRequest] { requestStore.pending }
    public var grants: [OpenGrant] { grantStore.grants }
    public var pendingResponseCount: Int { pendingResponses.count }

    public func handle(
        requestId: String,
        command: String,
        requesterIdentity: String,
        sessionIdentity: String
    ) {
        guard requestStore.claim(requestId: requestId) else { return }
        let parsed: ParsedOpenCommand
        do {
            parsed = try OpenCommandParser.parse(command)
        } catch let error as OpenCommandParseError {
            respond(requestId: requestId, code: error.exitCode, error: error.message)
            return
        } catch {
            respond(
                requestId: requestId, code: .usage,
                error: "open request could not be parsed")
            return
        }

        let approval = OpenApprovalRequest(
            requestId: requestId,
            command: parsed,
            requesterIdentity: boundedIdentity(requesterIdentity),
            sessionIdentity: boundedIdentity(sessionIdentity))
        requestStore.insertClaimed(
            approval, expiresAt: now().addingTimeInterval(timeout))

        if grantStore.contains(parsed.scope) {
            settle(requestId: requestId, code: .success, error: nil)
            return
        }

        publishApprovals()
        let progress = Data(Self.waitingProgress.utf8).base64EncodedString()
        guard send(.execChunk(requestId: requestId, stream: "stderr", data: progress)) else {
            settle(
                requestId: requestId, code: .unavailable,
                error: "Approval became unavailable")
            return
        }
        armTimeout(requestId: requestId)
    }

    public func resolve(requestId: String, decision: OpenApprovalDecision) {
        guard let request = requestStore.request(id: requestId) else { return }
        guard !requestStore.isExpired(id: requestId, at: now()) else {
            settle(
                requestId: requestId, code: .timeout,
                error: "Timed out waiting for approval")
            return
        }
        switch decision {
        case .deny:
            settle(requestId: requestId, code: .denied, error: "User denied the open request")
        case .allowOnce:
            settle(requestId: requestId, code: .success, error: nil)
        case .alwaysAllow:
            grantStore.grant(request.command.scope)
            onGrantsChanged(grantStore.grants)
            settle(requestId: requestId, code: .success, error: nil)
        }
    }

    public func cancel(requestId: String, signal: String) {
        guard requestStore.request(id: requestId) != nil else { return }
        settle(
            requestId: requestId, code: .cancelled,
            signal: signal, error: "Open approval was cancelled")
    }

    public func disconnect() {
        for request in requestStore.pending {
            settle(
                requestId: request.requestId, code: .cancelled,
                error: "Open approval was cancelled by disconnect")
        }
        requestStore.clearPending()
    }

    /// Retry responses whose transport send previously returned false.
    public func transportAvailable() {
        flushPendingResponses()
    }

    public func revokeGrant(id: UUID) {
        grantStore.revoke(id: id)
        onGrantsChanged(grantStore.grants)
    }

    public func revokeAllGrants() {
        grantStore.revokeAll()
        onGrantsChanged([])
    }

    private func armTimeout(requestId: String) {
        let nanoseconds = UInt64(timeout * 1_000_000_000)
        timeoutTasks[requestId] = Task { @MainActor [weak self, sleep] in
            try? await sleep(nanoseconds)
            guard !Task.isCancelled, let self,
                self.requestStore.isExpired(id: requestId, at: self.now())
            else { return }
            self.settle(
                requestId: requestId, code: .timeout,
                error: "Timed out waiting for approval")
        }
    }

    private func settle(
        requestId: String,
        code: OpenExecExitCode,
        signal: String? = nil,
        error: String?
    ) {
        guard requestStore.settle(id: requestId) != nil else { return }
        timeoutTasks.removeValue(forKey: requestId)?.cancel()
        publishApprovals()
        respond(requestId: requestId, code: code, signal: signal, error: error)
    }

    private func respond(
        requestId: String,
        code: OpenExecExitCode,
        signal: String? = nil,
        error: String?
    ) {
        flushPendingResponses()
        if pendingResponses.count == pendingResponseLimit {
            // If delivery remains unavailable, evict the oldest response and retain
            // FIFO order among every surviving response before appending the newest.
            pendingResponses.removeFirst()
        }
        pendingResponses.append(
            .execResponse(
                requestId: requestId, exitCode: code.rawValue,
                signal: signal, error: error))
        flushPendingResponses()
    }

    private func flushPendingResponses() {
        while let response = pendingResponses.first, send(response) {
            pendingResponses.removeFirst()
        }
    }

    private func publishApprovals() {
        onApprovalsChanged(requestStore.pending)
    }

    private func boundedIdentity(_ value: String) -> String {
        let clean = value.unicodeScalars
            .filter { !CharacterSet.controlCharacters.contains($0) }
            .map(String.init)
            .joined()
        return String(clean.prefix(80))
    }
}
