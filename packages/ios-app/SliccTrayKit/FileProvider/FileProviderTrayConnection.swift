import Foundation
import WebRTC

@MainActor
protocol FileProviderFSConnection: FileProviderFSClient {
    func disconnect()
}

@MainActor
public final class FileProviderFSClientPool: FileProviderFSClient {
    typealias ConnectionBuilder = (TrayCredentials) async throws -> FileProviderFSConnection

    private let loadCredentials: () -> TrayCredentials?
    private let buildConnection: ConnectionBuilder
    private let connectionTimeout: TimeInterval
    private let idleTimeout: TimeInterval
    private var connection: FileProviderFSConnection?
    private var connectionTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var idleTask: Task<Void, Never>?
    private var waiters: [CheckedContinuation<FileProviderFSConnection, Error>] = []

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

    public func disconnect() {
        idleTask?.cancel()
        idleTask = nil
        connectionTask?.cancel()
        connectionTask = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        connection?.disconnect()
        connection = nil
        finishWaiters(.failure(VFSProviderError.serverUnreachable))
    }

    private func connectedClient() async throws -> FileProviderFSConnection {
        if let connection { return connection }
        guard let credentials = loadCredentials() else {
            throw VFSProviderError.missingCredentials
        }
        return try await withCheckedThrowingContinuation { continuation in
            waiters.append(continuation)
            guard connectionTask == nil else { return }

            connectionTask = Task { [weak self, buildConnection] in
                do {
                    let connection = try await buildConnection(credentials)
                    guard !Task.isCancelled else {
                        connection.disconnect()
                        return
                    }
                    self?.connection = connection
                    self?.finishWaiters(.success(connection))
                } catch is CancellationError {
                    self?.finishWaiters(.failure(VFSProviderError.serverUnreachable))
                } catch {
                    self?.finishWaiters(.failure(error))
                }
            }
            let connectionTimeout = self.connectionTimeout
            timeoutTask = Task { [weak self] in
                do {
                    try await Task.sleep(
                        nanoseconds: UInt64(connectionTimeout * 1_000_000_000))
                } catch {
                    return
                }
                guard let self, self.connection == nil else { return }
                self.connectionTask?.cancel()
                self.connectionTask = nil
                self.finishWaiters(.failure(VFSProviderError.serverUnreachable))
            }
        }
    }

    private func finishWaiters(_ result: Result<FileProviderFSConnection, Error>) {
        timeoutTask?.cancel()
        timeoutTask = nil
        connectionTask = nil
        let pending = waiters
        waiters.removeAll()
        for waiter in pending { waiter.resume(with: result) }
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
private final class TrayFileProviderConnection: NSObject, FileProviderFSConnection {
    private let connector: TrayFollowerConnector
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

    static func connect(joinURL: URL) async throws -> TrayFileProviderConnection {
        let connection = TrayFileProviderConnection(joinURL: joinURL)
        try await connection.start()
        return connection
    }

    func readBinaryFile(_ path: String) async throws -> Data {
        try await fsClient.readBinaryFile(path)
    }

    func readDir(_ path: String) async throws -> [TrayFsDirEntry] {
        try await fsClient.readDir(path)
    }

    func stat(_ path: String) async throws -> TrayFsStat {
        try await fsClient.stat(path)
    }

    func disconnect() {
        connector.stop()
        fsClient.cancelAll()
        sendData = nil
        reassembler.removeAll()
        resumeConnect(.failure(VFSProviderError.serverUnreachable))
    }

    private func start() async throws {
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
                        runtime: "slicc-ios-file-provider",
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
