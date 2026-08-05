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
        evictOldestSettledTombstone()
        return true
    }

    /// Eviction skips IDs whose request is still live, so `seenRequestIds`
    /// stays a superset of `entries.keys` and a pending request can never be
    /// replayed. The limit is soft while more than `tombstoneLimit` requests
    /// are outstanding at once.
    private func evictOldestSettledTombstone() {
        guard seenRequestOrder.count > tombstoneLimit,
            let index = seenRequestOrder.firstIndex(where: { entries[$0] == nil })
        else { return }
        seenRequestIds.remove(seenRequestOrder.remove(at: index))
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
    /// Failed terminal deliveries are retried FIFO on reconnect. A delivery may
    /// contain stdout followed by its response, so callback JSON cannot be split
    /// from settlement when the transport disappears between sends.

    private struct PendingDelivery {
        var messages: [FollowerToLeaderMessage]
    }

    private let grantStore: OpenGrantStore
    private let requestStore: OpenRequestStore
    private let timeout: TimeInterval
    private let now: () -> Date
    private let sleep: @Sendable (UInt64) async throws -> Void
    private let send: (FollowerToLeaderMessage) -> Bool
    private let launch: (OpenLaunchRequest) -> Void
    private let makeNonce: () throws -> String
    private let onApprovalsChanged: ([OpenApprovalRequest]) -> Void
    private let onGrantsChanged: ([OpenGrant]) -> Void
    private var timeoutTasks: [String: Task<Void, Never>] = [:]
    private var pendingDeliveries: [PendingDelivery] = []
    private var approvalRequestIds: Set<String> = []
    private var callbackNonces: [String: String] = [:]
    private var grantAfterLaunch: Set<String> = []
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
        launch: @escaping (OpenLaunchRequest) -> Void,
        makeNonce: @escaping () throws -> String = { try OpenCallbackCodec.makeNonce() },
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
        self.launch = launch
        self.makeNonce = makeNonce
        self.onApprovalsChanged = onApprovalsChanged
        self.onGrantsChanged = onGrantsChanged
    }

    public var pendingApprovals: [OpenApprovalRequest] {
        requestStore.pending.filter { approvalRequestIds.contains($0.requestId) }
    }
    public var grants: [OpenGrant] { grantStore.grants }
    public var pendingResponseCount: Int { pendingDeliveries.count }

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
        armTimeout(requestId: requestId)

        if grantStore.contains(parsed.scope) {
            beginLaunch(requestId: requestId, persistGrant: false)
            return
        }

        approvalRequestIds.insert(requestId)
        publishApprovals()
        let progress = Data(Self.waitingProgress.utf8).base64EncodedString()
        guard send(.execChunk(requestId: requestId, stream: "stderr", data: progress)) else {
            settle(
                requestId: requestId, code: .unavailable,
                error: "Approval became unavailable")
            return
        }
    }

    public func resolve(requestId: String, decision: OpenApprovalDecision) {
        guard requestStore.request(id: requestId) != nil else { return }
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
            beginLaunch(requestId: requestId, persistGrant: false)
        case .alwaysAllow:
            beginLaunch(requestId: requestId, persistGrant: true)
        }
    }

    public func completeLaunch(requestId: String, opened: Bool) {
        guard let request = requestStore.request(id: requestId) else { return }
        guard !requestStore.isExpired(id: requestId, at: now()) else {
            settle(requestId: requestId, code: .timeout, error: "Open request timed out")
            return
        }
        guard opened else {
            settle(
                requestId: requestId, code: .unavailable,
                error: "The destination app is unavailable")
            return
        }
        persistGrantIfNeeded(for: request)
        guard request.command.mode != .xCallback else { return }
        settle(requestId: requestId, code: .success, error: nil)
    }

    /// Returns true for every app-owned callback URL, including malformed or
    /// stale values. Callers must consume those URLs rather than route them into
    /// any other deep-link handler. Invalid correlations intentionally emit nothing.
    public func handleCallbackURL(_ url: URL) -> Bool {
        guard OpenCallbackCodec.owns(url) else { return false }
        switch OpenCallbackCodec.decode(url) {
        case .ignored:
            return true
        case .overflow(let requestId, let nonce):
            guard let request = liveCallbackRequest(requestId: requestId, nonce: nonce) else {
                return true
            }
            persistGrantIfNeeded(for: request)
            settle(
                requestId: requestId, code: .callbackError,
                error: "The x-callback result exceeded its safe bounds")
        case .result(let requestId, let nonce, let result, let json):
            guard let request = liveCallbackRequest(requestId: requestId, nonce: nonce) else {
                return true
            }
            persistGrantIfNeeded(for: request)
            let code: OpenExecExitCode
            let error: String?
            switch result.status {
            case .success:
                code = .success
                error = nil
            case .error:
                code = .callbackError
                error = "The destination app reported an x-callback error"
            case .cancel:
                code = .cancelled
                error = "The destination app cancelled the x-callback request"
            }
            var stdout = json
            stdout.append(0x0A)
            settle(requestId: requestId, code: code, error: error, stdout: stdout)
        }
        return true
    }

    public func cancel(requestId: String, signal: String) {
        guard requestStore.request(id: requestId) != nil else { return }
        settle(
            requestId: requestId, code: .cancelled,
            signal: signal, error: "Open request was cancelled")
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
                error: "Open request timed out")
        }
    }

    private func beginLaunch(requestId: String, persistGrant: Bool) {
        guard let request = requestStore.request(id: requestId) else { return }
        approvalRequestIds.remove(requestId)
        publishApprovals()
        if persistGrant { grantAfterLaunch.insert(requestId) }

        let nonce: String?
        do {
            nonce = request.command.mode == .xCallback ? try makeNonce() : nil
            if let nonce { callbackNonces[requestId] = nonce }
            let url = try OpenCallbackCodec.launchURL(
                for: request.command, requestId: requestId, nonce: nonce ?? "")
            launch(OpenLaunchRequest(requestId: requestId, url: url, mode: request.command.mode))
        } catch {
            settle(
                requestId: requestId, code: .unavailable,
                error: "The approved destination could not be opened")
        }
    }

    private func liveCallbackRequest(requestId: String, nonce: String) -> OpenApprovalRequest? {
        guard let expectedNonce = callbackNonces[requestId],
            OpenCallbackCodec.constantTimeNonceEqual(expectedNonce, nonce),
            let request = requestStore.request(id: requestId)
        else { return nil }
        guard !requestStore.isExpired(id: requestId, at: now()) else {
            settle(requestId: requestId, code: .timeout, error: "Open request timed out")
            return nil
        }
        return request
    }

    private func persistGrantIfNeeded(for request: OpenApprovalRequest) {
        guard grantAfterLaunch.remove(request.requestId) != nil else { return }
        grantStore.grant(request.command.scope)
        onGrantsChanged(grantStore.grants)
    }

    private func settle(
        requestId: String,
        code: OpenExecExitCode,
        signal: String? = nil,
        error: String?,
        stdout: Data? = nil
    ) {
        guard requestStore.settle(id: requestId) != nil else { return }
        timeoutTasks.removeValue(forKey: requestId)?.cancel()
        approvalRequestIds.remove(requestId)
        callbackNonces.removeValue(forKey: requestId)
        grantAfterLaunch.remove(requestId)
        publishApprovals()
        var messages: [FollowerToLeaderMessage] = []
        if let stdout {
            messages.append(
                .execChunk(
                    requestId: requestId, stream: "stdout",
                    data: stdout.base64EncodedString()))
        }
        messages.append(
            .execResponse(
                requestId: requestId, exitCode: code.rawValue,
                signal: signal, error: error))
        enqueueDelivery(messages)
    }

    private func respond(
        requestId: String,
        code: OpenExecExitCode,
        signal: String? = nil,
        error: String?
    ) {
        enqueueDelivery([
            .execResponse(
                requestId: requestId, exitCode: code.rawValue,
                signal: signal, error: error)
        ])
    }

    private func enqueueDelivery(_ messages: [FollowerToLeaderMessage]) {
        flushPendingResponses()
        if pendingDeliveries.count == pendingResponseLimit { pendingDeliveries.removeFirst() }
        pendingDeliveries.append(PendingDelivery(messages: messages))
        flushPendingResponses()
    }

    private func flushPendingResponses() {
        while !pendingDeliveries.isEmpty {
            guard let message = pendingDeliveries[0].messages.first else {
                pendingDeliveries.removeFirst()
                continue
            }
            guard send(message) else { return }
            pendingDeliveries[0].messages.removeFirst()
            if pendingDeliveries[0].messages.isEmpty { pendingDeliveries.removeFirst() }
        }
    }

    private func publishApprovals() {
        onApprovalsChanged(pendingApprovals)
    }

    private func boundedIdentity(_ value: String) -> String {
        let clean = value.unicodeScalars
            .filter { !CharacterSet.controlCharacters.contains($0) }
            .map(String.init)
            .joined()
        return String(clean.prefix(80))
    }
}
