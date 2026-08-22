import Foundation
import SliccTrayFollower
import WebRTC

@MainActor
protocol FileProviderFSConnection: FileProviderFSClient {
    func disconnect()
}

@MainActor
protocol FileProviderTrayConnector: AnyObject {
    var delegate: TrayFollowerConnectorDelegate? { get set }
    func start() async throws
    func stop()
}

extension TrayFollowerConnector: FileProviderTrayConnector {}

@MainActor
public final class FileProviderFSClientPool: FileProviderFSClient {
    typealias ConnectionBuilder = (TrayCredentials) async throws -> FileProviderFSConnection

    private struct ConnectionAttempt {
        let id: UUID
        var waiters: [CheckedContinuation<FileProviderFSConnection, Error>]
        var connectionTask: Task<Void, Never>?
        var timeoutTask: Task<Void, Never>?
    }

    private let loadCredentials: () -> TrayCredentials?
    private let buildConnection: ConnectionBuilder
    private let connectionTimeout: TimeInterval
    private let idleTimeout: TimeInterval
    private var connection: FileProviderFSConnection?
    private var attempt: ConnectionAttempt?
    private var idleTask: Task<Void, Never>?

    public convenience init(
        connectionTimeout: TimeInterval = 12, idleTimeout: TimeInterval = 10
    ) {
        self.init(
            connectionTimeout: connectionTimeout,
            idleTimeout: idleTimeout,
            loadCredentials: { TrayCredentialStore().load() },
            buildConnection: { credentials in
                try await TrayFileProviderConnection.connect(joinURL: credentials.joinURL)
            })
    }

    init(
        connectionTimeout: TimeInterval,
        idleTimeout: TimeInterval,
        loadCredentials: @escaping () -> TrayCredentials?,
        buildConnection: @escaping ConnectionBuilder
    ) {
        self.connectionTimeout = connectionTimeout
        self.idleTimeout = idleTimeout
        self.loadCredentials = loadCredentials
        self.buildConnection = buildConnection
    }

    public func readBinaryFile(_ path: String) async throws -> Data {
        let client = try await connectedClient()
        defer { scheduleIdleDisconnect() }
        return try await client.readBinaryFile(path)
    }

    public func writeBinaryFile(_ path: String, data: Data) async throws {
        let client = try await connectedClient()
        defer { scheduleIdleDisconnect() }
        try await client.writeBinaryFile(path, data: data)
    }

    public func readDir(_ path: String) async throws -> [TrayFsDirEntry] {
        let client = try await connectedClient()
        defer { scheduleIdleDisconnect() }
        return try await client.readDir(path)
    }

    public func stat(_ path: String) async throws -> TrayFsStat {
        let client = try await connectedClient()
        defer { scheduleIdleDisconnect() }
        return try await client.stat(path)
    }

    public func mkdir(_ path: String, recursive: Bool) async throws {
        let client = try await connectedClient()
        defer { scheduleIdleDisconnect() }
        try await client.mkdir(path, recursive: recursive)
    }

    public func remove(_ path: String, recursive: Bool) async throws {
        let client = try await connectedClient()
        defer { scheduleIdleDisconnect() }
        try await client.remove(path, recursive: recursive)
    }

    public func disconnect() {
        idleTask?.cancel()
        idleTask = nil
        attempt?.connectionTask?.cancel()
        attempt?.timeoutTask?.cancel()
        let waiters = attempt?.waiters ?? []
        attempt = nil
        connection?.disconnect()
        connection = nil
        resume(waiters, with: .failure(VFSProviderError.serverUnreachable))
    }

    private func connectedClient() async throws -> FileProviderFSConnection {
        if let connection { return connection }
        guard let credentials = loadCredentials() else {
            throw VFSProviderError.missingCredentials
        }
        return try await withCheckedThrowingContinuation { continuation in
            if attempt != nil {
                attempt?.waiters.append(continuation)
                return
            }

            let id = UUID()
            attempt = ConnectionAttempt(
                id: id, waiters: [continuation], connectionTask: nil, timeoutTask: nil)
            let connectionTask = Task { [weak self, buildConnection] in
                do {
                    let connection = try await buildConnection(credentials)
                    self?.finishAttempt(id, with: .success(connection))
                } catch {
                    self?.finishAttempt(id, with: .failure(error))
                }
            }
            let connectionTimeout = self.connectionTimeout
            let timeoutTask = Task { [weak self] in
                do {
                    try await Task.sleep(
                        nanoseconds: UInt64(connectionTimeout * 1_000_000_000))
                } catch {
                    return
                }
                self?.timeoutAttempt(id)
            }
            attempt?.connectionTask = connectionTask
            attempt?.timeoutTask = timeoutTask
        }
    }

    private func finishAttempt(
        _ id: UUID, with result: Result<FileProviderFSConnection, Error>
    ) {
        guard let current = attempt, current.id == id else {
            if case .success(let staleConnection) = result { staleConnection.disconnect() }
            return
        }
        current.timeoutTask?.cancel()
        attempt = nil
        if case .success(let connection) = result { self.connection = connection }
        resume(current.waiters, with: result)
    }

    private func timeoutAttempt(_ id: UUID) {
        guard let current = attempt, current.id == id else { return }
        current.connectionTask?.cancel()
        attempt = nil
        resume(current.waiters, with: .failure(VFSProviderError.serverUnreachable))
    }

    private func resume(
        _ waiters: [CheckedContinuation<FileProviderFSConnection, Error>],
        with result: Result<FileProviderFSConnection, Error>
    ) {
        for waiter in waiters { waiter.resume(with: result) }
    }

    private func scheduleIdleDisconnect() {
        idleTask?.cancel()
        idleTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: UInt64(idleTimeout * 1_000_000_000))
            } catch {
                return
            }
            self.connection?.disconnect()
            self.connection = nil
        }
    }
}

@MainActor
final class TrayFileProviderConnection: NSObject, FileProviderFSConnection {
    private let connector: FileProviderTrayConnector
    private lazy var fsClient = FsClient(timeout: 20) { [weak self] message in
        self?.send(message) ?? false
    }
    private var sendData: ((Data) -> Bool)?
    private var connectContinuation: CheckedContinuation<Void, Error>?
    private var reassembler = TrayChunkReassembler()

    private init(joinURL: URL) {
        connector = TrayFollowerConnector(joinUrl: joinURL)
        super.init()
        connector.delegate = self
    }

    init(connector: FileProviderTrayConnector) {
        self.connector = connector
        super.init()
        connector.delegate = self
    }

    static func connect(joinURL: URL) async throws -> TrayFileProviderConnection {
        let connection = TrayFileProviderConnection(joinURL: joinURL)
        try await connection.start()
        return connection
    }

    func readBinaryFile(_ path: String) async throws -> Data {
        try await fsClient.readBinaryFile(path)
    }

    func writeBinaryFile(_ path: String, data: Data) async throws {
        try await fsClient.writeBinaryFile(path, data: data)
    }

    func readDir(_ path: String) async throws -> [TrayFsDirEntry] {
        try await fsClient.readDir(path)
    }

    func stat(_ path: String) async throws -> TrayFsStat {
        try await fsClient.stat(path)
    }

    func mkdir(_ path: String, recursive: Bool) async throws {
        try await fsClient.mkdir(path, recursive: recursive)
    }

    func remove(_ path: String, recursive: Bool) async throws {
        try await fsClient.remove(path, recursive: recursive)
    }

    func disconnect() {
        connector.stop()
        fsClient.cancelAll()
        sendData = nil
        reassembler.removeAll()
        resumeConnect(.failure(VFSProviderError.serverUnreachable))
    }

    func start() async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                connectContinuation = continuation
                Task { [weak self] in
                    guard let self else { return }
                    do {
                        try await self.connector.start()
                    } catch {
                        self.resumeConnect(.failure(error))
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.disconnect() }
        }
    }

    private func send(_ message: FollowerToLeaderMessage) -> Bool {
        guard let sendData else { return false }
        do {
            return sendData(try JSONEncoder().encode(message))
        } catch {
            return false
        }
    }

    private func route(_ data: Data) {
        struct Envelope: Decodable { let type: String }
        do {
            let envelope = try JSONDecoder().decode(Envelope.self, from: data)
            if envelope.type == TrayChunkFrame.typeTag {
                let frame = try JSONDecoder().decode(TrayChunkFrame.self, from: data)
                if let message = reassembler.accept(frame).message { route(message) }
                return
            }
            let message = try JSONDecoder().decode(LeaderToFollowerMessage.self, from: data)
            switch message {
            case .fsResponse(let requestId, let response):
                fsClient.handleResponse(requestId: requestId, response: response)
            case .fsRequest(let requestId, let request):
                _ = send(.fsResponse(requestId: requestId, response: FsClient.refusal(for: request)))
            case .ping:
                _ = send(.pong)
            default:
                break
            }
        } catch {
            // Invalid or unrelated leader traffic cannot satisfy an fs waiter;
            // the request deadline remains the authoritative failure path.
        }
    }

    private func resumeConnect(_ result: Result<Void, Error>) {
        guard let continuation = connectContinuation else { return }
        connectContinuation = nil
        continuation.resume(with: result)
    }
}

extension TrayFileProviderConnection: TrayFollowerConnectorDelegate {
    nonisolated func connector(
        _ connector: TrayFollowerConnector, didConnect channelSend: @escaping (Data) -> Bool
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.sendData = channelSend
            guard
                self.send(
                    .hello(
                        protocolVersion: traySyncProtocolVersion,
                        runtime: TrayCredentialConfiguration.fileProviderRuntime,
                        capabilities: trayFollowerCapabilities,
                        motd: nil))
            else {
                self.resumeConnect(.failure(VFSProviderError.serverUnreachable))
                return
            }
            self.resumeConnect(.success(()))
        }
    }

    nonisolated func connectorDidDisconnect(_ connector: TrayFollowerConnector, reason: String) {
        Task { @MainActor [weak self] in
            self?.fsClient.cancelAll()
            self?.sendData = nil
            self?.resumeConnect(.failure(VFSProviderError.serverUnreachable))
        }
    }

    nonisolated func connector(_ connector: TrayFollowerConnector, isReconnecting attempt: Int) {}

    nonisolated func connector(_ connector: TrayFollowerConnector, didGiveUp lastError: String) {
        connectorDidDisconnect(connector, reason: lastError)
    }

    nonisolated func connector(
        _ connector: TrayFollowerConnector, didReceiveInfo trayId: String, participantCount: Int
    ) {}

    nonisolated func connector(
        _ connector: TrayFollowerConnector, didGenerateCandidate candidate: RTCIceCandidate
    ) {}

    nonisolated func connector(_ connector: TrayFollowerConnector, didReceiveData data: Data) {
        Task { @MainActor [weak self] in self?.route(data) }
    }
}
