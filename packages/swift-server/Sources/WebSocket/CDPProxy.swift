import AsyncHTTPClient
import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOCore
import NIOHTTP1
import NIOWebSocket
import WebSocketKit

actor CDPProxy {
    static let defaultMaxMessageSize = 100 * 1024 * 1024
    static let defaultChromeInboundMessageBufferLimit = 1_000
    static let defaultReconnectDelayNanoseconds: UInt64 = 1_000_000_000

    private let logger: Logger
    private let logDedup: CliLogDedup
    private let discoverer: @Sendable (Int) async throws -> String
    private let chromeConnector: ChromeSocketConnector
    private let maxMessageSize: Int
    private let maxBufferSize = 1_000
    private let reconnectDelayNanoseconds: UInt64
    private let sleep: @Sendable (UInt64) async throws -> Void

    private var cdpPort: Int?
    private var cachedCDPPort: Int?
    private var cachedCDPURL: String?
    private var chromeSocket: ChromeSocketHandle?
    private var chromeConnectionID: UUID?
    private var chromeConnectionTask: Task<ChromeSocketHandle, Error>?
    private var chromeReconnectTask: Task<Void, Never>?
    private var activeClient: ClientHandle?
    private var messageBuffer: [ProxyMessage]?

    // WebKit pipe bridge state
    private var pipeWrite: FileHandle?
    private var pipeRead: FileHandle?
    private var pipeReadTask: Task<Void, Never>?
    /// Byte-level buffer for incomplete null-byte delimited messages.
    /// We split frames on raw 0x00 before decoding so a UTF-8 codepoint
    /// split across pipe reads never produces replacement characters.
    private var pipeBuffer: Data = Data()
    private var pipeMode: Bool = false

    init(
        logger: Logger = Logger(label: "slicc.cdp-proxy"),
        maxMessageSize: Int = CDPProxy.defaultMaxMessageSize,
        discoverer: (@Sendable (Int) async throws -> String)? = nil,
        chromeConnector: ChromeSocketConnector? = nil,
        reconnectDelayNanoseconds: UInt64 = CDPProxy.defaultReconnectDelayNanoseconds,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }
    ) {
        self.logger = logger
        self.maxMessageSize = maxMessageSize
        self.discoverer = discoverer ?? Self.defaultDiscoverCDPURL(port:)
        self.chromeConnector = chromeConnector ?? { url, onMessage, onEvent in
            try await Self.defaultChromeConnector(
                url: url,
                maxFrameSize: maxMessageSize,
                onMessage: onMessage,
                onEvent: onEvent
            )
        }
        self.reconnectDelayNanoseconds = reconnectDelayNanoseconds
        self.sleep = sleep
        self.logDedup = CliLogDedup(prefix: "[cdp-proxy]", sink: { summary in
            logger.debug("\(summary)")
        })
    }

    func install(on router: Router<BasicWebSocketRequestContext>, cdpPort: Int) {
        self.cdpPort = cdpPort
        let isPipeMode = self.pipeMode
        router.ws("/cdp") { _, _ in
            .upgrade([:])
        } onUpgrade: { inbound, outbound, context in
            if isPipeMode {
                try await self.handlePipeClientConnection(
                    inbound: inbound,
                    outbound: outbound
                )
            } else {
                try await self.handleClientConnection(
                    inbound: inbound,
                    outbound: outbound,
                    context: context,
                    cdpPort: cdpPort
                )
            }
        }
    }

    /// Configure the proxy in pipe mode for WebKit inspector pipe bridge.
    /// In this mode, WebSocket messages are forwarded to/from the pipe instead of Chrome's WebSocket.
    func installPipeMode(pipeWrite: FileHandle, pipeRead: FileHandle) {
        self.pipeMode = true
        self.pipeWrite = pipeWrite
        self.pipeRead = pipeRead
        self.startPipeReader()
        self.logger.info("[cdp-proxy] WebKit pipe bridge ready")
    }

    func preWarm(cdpPort: Int) async throws {
        guard !pipeMode else {
            // In pipe mode, no need to pre-warm — pipe is already connected
            return
        }
        self.cdpPort = cdpPort
        let cdpURL = try await self.cdpURL(for: cdpPort)
        try await self.ensureChromeConnection(url: cdpURL)
    }

    func discoverCDPUrl(port: Int) async throws -> String {
        try await self.discoverer(port)
    }

    func ensureChromeConnection(url: String) async throws {
        if let chromeSocket, chromeSocket.isOpen() {
            try await self.flushBufferedMessages(using: chromeSocket)
            return
        }

        if let chromeConnectionTask {
            let chromeSocket = try await chromeConnectionTask.value
            if self.chromeSocket == nil {
                self.chromeSocket = chromeSocket
            }
            try await self.flushBufferedMessages(using: chromeSocket)
            return
        }

        if let chromeSocket {
            await chromeSocket.close()
            self.chromeSocket = nil
        }

        let connectionID = UUID()
        let connectTask = Task<ChromeSocketHandle, Error> {
            try await self.chromeConnector(
                url,
                { [weak self] message in
                    guard let self else { return }
                    await self.handleChromeMessage(message, connectionID: connectionID)
                },
                { [weak self] event in
                    guard let self else { return }
                    await self.handleChromeEvent(event, connectionID: connectionID)
                }
            )
        }

        self.chromeConnectionID = connectionID
        self.chromeConnectionTask = connectTask

        do {
            let chromeSocket = try await connectTask.value
            guard self.chromeConnectionID == connectionID else {
                await chromeSocket.close()
                return
            }

            self.chromeSocket = chromeSocket
            self.chromeConnectionTask = nil
            self.logger.info("[cdp-proxy] chromeWs open")
            try await self.flushBufferedMessages(using: chromeSocket)
        } catch {
            if self.chromeConnectionID == connectionID {
                self.chromeConnectionTask = nil
                self.chromeSocket = nil
            }
            self.logger.error("[cdp-proxy] Chrome WS error: \(String(describing: error))")
            throw error
        }
    }

    func addClient(_ client: ClientHandle) async {
        if let activeClient {
            self.logger.info("[cdp-proxy] Closing previous client connection")
            await activeClient.close(.goingAway, "Replaced by newer /cdp client")
        }

        self.activeClient = client
        if self.messageBuffer == nil {
            self.messageBuffer = []
        }
        self.logger.info("[cdp-proxy] New client connected")
    }

    func receive(_ message: ProxyMessage, from clientID: UUID) async {
        guard self.activeClient?.id == clientID else {
            return
        }

        let preview = message.preview
        if let chromeSocket, chromeSocket.isOpen(), self.messageBuffer == nil {
            let logLine = "[cdp-proxy] Client→Chrome: \(preview)"
            if self.logDedup.shouldLog(logLine) {
                self.logger.debug("\(logLine)")
            }

            do {
                try await chromeSocket.send(message)
            } catch {
                self.logger.error("[cdp-proxy] Chrome WS error: \(String(describing: error))")
                self.handleChromeDisconnect(
                    reason: "send failure: \(String(describing: error))",
                    bufferMessage: message
                )
            }
        } else if self.messageBuffer != nil {
            self.appendBufferedMessage(message)
            let logLine = "[cdp-proxy] Client→Chrome (buffered): \(preview)"
            if self.logDedup.shouldLog(logLine) {
                self.logger.debug("\(logLine)")
            }
        } else {
            self.logger.warning("[cdp-proxy] Client→Chrome (DROPPED — no connection): \(preview)")
        }
    }

    func removeClient(id: UUID, reason: String) async {
        guard self.activeClient?.id == id else {
            return
        }
        self.activeClient = nil
        self.logger.info("[cdp-proxy] \(reason)")
    }

    func prepareClientConnection(for clientID: UUID, cdpPort: Int) async {
        do {
            self.cdpPort = cdpPort
            let cdpURL = try await self.cdpURL(for: cdpPort)
            try await self.ensureChromeConnection(url: cdpURL)
        } catch {
            self.logger.error("[cdp-proxy] Connection error: \(String(describing: error))")
            if self.activeClient?.id == clientID {
                await self.activeClient?.close(.goingAway, "Failed to connect to Chrome CDP")
                self.activeClient = nil
            }
        }
    }

    /// Write a message to the WebKit inspector pipe (null-byte delimited).
    func writeToPipe(_ text: String) {
        guard let pipeWrite else { return }
        let message = text + "\0"
        if let data = message.data(using: .utf8) {
            pipeWrite.write(data)
        }
    }

    func shutdown() async {
        self.pipeReadTask?.cancel()
        self.pipeReadTask = nil

        self.chromeConnectionTask?.cancel()
        self.chromeReconnectTask?.cancel()
        self.chromeConnectionTask = nil
        self.chromeReconnectTask = nil
        self.chromeConnectionID = nil
        self.messageBuffer = nil

        if let chromeSocket = self.chromeSocket {
            await chromeSocket.close()
            self.chromeSocket = nil
        }

        if let activeClient = self.activeClient {
            await activeClient.close(.goingAway, "Server shutting down")
            self.activeClient = nil
        }
    }

    private func cdpURL(for port: Int) async throws -> String {
        if self.cachedCDPPort == port, let cachedCDPURL {
            return cachedCDPURL
        }

        let discoveredURL = try await Self.cdpURL(for: port, using: self.discoverer)
        self.cachedCDPPort = port
        self.cachedCDPURL = discoveredURL
        self.logger.info("[cdp-proxy] CDP available at: \(discoveredURL)")
        return discoveredURL
    }

    private func appendBufferedMessage(_ message: ProxyMessage) {
        guard var buffer = self.messageBuffer else {
            return
        }

        if buffer.count >= self.maxBufferSize {
            self.logger.warning("[cdp-proxy] Message buffer full (\(self.maxBufferSize)), dropping oldest message")
            buffer.removeFirst()
        }

        buffer.append(message)
        self.messageBuffer = buffer
    }

    private func flushBufferedMessages(using chromeSocket: ChromeSocketHandle) async throws {
        guard let bufferedMessages = self.messageBuffer else {
            return
        }

        self.messageBuffer = nil
        for bufferedMessage in bufferedMessages {
            try await chromeSocket.send(bufferedMessage)
        }
    }

    private func handleChromeMessage(_ message: ProxyMessage, connectionID: UUID) async {
        guard self.chromeConnectionID == connectionID else {
            return
        }

        let logLine = "[cdp-proxy] Chrome→Client: \(message.preview)"
        if self.logDedup.shouldLog(logLine) {
            self.logger.debug("\(logLine)")
        }

        guard let activeClient = self.activeClient else {
            return
        }

        do {
            try await activeClient.send(message)
        } catch {
            self.logger.error("[cdp-proxy] Client WS error: \(String(describing: error))")
            if self.activeClient?.id == activeClient.id {
                self.activeClient = nil
            }
        }
    }

    private func handleChromeEvent(_ event: ChromeSocketEvent, connectionID: UUID) async {
        guard self.chromeConnectionID == connectionID else {
            return
        }

        switch event {
        case .closed(let description):
            self.logger.info("[cdp-proxy] Chrome WS closed. \(description)")
            self.handleChromeDisconnect(reason: "closed: \(description)")
        case .error(let description):
            self.logger.error("[cdp-proxy] Chrome WS error: \(description)")
            self.handleChromeDisconnect(reason: "error: \(description)")
        }
    }

    private func handleClientConnection(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter,
        context _: WebSocketRouterContext<BasicWebSocketRequestContext>,
        cdpPort: Int
    ) async throws {
        let client = ClientHandle(
            send: { message in
                switch message {
                case .text(let text):
                    try await outbound.write(.text(text))
                case .binary(let buffer):
                    try await outbound.write(.binary(buffer))
                }
            },
            close: { code, reason in
                try? await outbound.close(code, reason: reason)
            }
        )

        await self.addClient(client)
        let clientID = client.id

        Task {
            await self.prepareClientConnection(for: clientID, cdpPort: cdpPort)
        }

        do {
            var iterator = inbound.makeAsyncIterator()
            while let message = try await iterator.nextMessage(maxSize: self.maxMessageSize) {
                await self.receive(ProxyMessage(message), from: clientID)
            }
            await self.removeClient(id: clientID, reason: "[cdp-proxy] Client disconnected")
        } catch {
            self.logger.error("[cdp-proxy] Client WS error: \(String(describing: error))")
            await self.removeClient(id: clientID, reason: "[cdp-proxy] Client disconnected")
        }
    }

    private static func defaultDiscoverCDPURL(port: Int) async throws -> String {
        let request = HTTPClientRequest(url: "http://127.0.0.1:\(port)/json/version")
        let response = try await HTTPClient.shared.execute(request, timeout: .seconds(5))
        guard response.status == .ok else {
            throw CDPProxyError.discoveryFailed("Unexpected status \(response.status.code) while discovering CDP URL")
        }

        let bodyBuffer = try await response.body.collect(upTo: 1024 * 1024)
        let bodyData = Data(bodyBuffer.readableBytesView)
        let payload = try JSONDecoder().decode(CDPVersionPayload.self, from: bodyData)
        guard !payload.webSocketDebuggerUrl.isEmpty else {
            throw CDPProxyError.discoveryFailed("Missing webSocketDebuggerUrl in /json/version response")
        }
        return payload.webSocketDebuggerUrl
    }

    private static func cdpURL(
        for port: Int,
        using discoverer: @escaping @Sendable (Int) async throws -> String
    ) async throws -> String {
        try await discoverer(port)
    }

    private func handleChromeDisconnect(reason: String, bufferMessage: ProxyMessage? = nil) {
        self.chromeSocket = nil
        self.chromeConnectionID = nil
        self.chromeConnectionTask = nil

        if self.messageBuffer == nil, self.activeClient != nil || bufferMessage != nil {
            self.messageBuffer = []
        }

        if let bufferMessage {
            self.appendBufferedMessage(bufferMessage)
        }

        self.scheduleChromeReconnect(reason: reason)
    }

    private func scheduleChromeReconnect(reason: String) {
        guard self.chromeReconnectTask == nil else {
            return
        }

        guard let cdpPort = self.cdpPort else {
            self.logger.warning("[cdp-proxy] Chrome WS dropped but no CDP port is available for reconnect")
            return
        }

        let delayMs = self.reconnectDelayNanoseconds / 1_000_000
        self.logger.info("[cdp-proxy] Scheduling Chrome WS reconnect in \(delayMs)ms (\(reason))")
        self.chromeReconnectTask = Task { [cdpPort] in
            await self.runChromeReconnectLoop(cdpPort: cdpPort)
        }
    }

    private func runChromeReconnectLoop(cdpPort: Int) async {
        defer {
            self.chromeReconnectTask = nil
        }

        while !Task.isCancelled {
            do {
                try await self.sleep(self.reconnectDelayNanoseconds)
                let freshURL = try await Self.cdpURL(for: cdpPort, using: self.discoverer)
                self.cachedCDPPort = cdpPort
                self.cachedCDPURL = freshURL
                try await self.ensureChromeConnection(url: freshURL)
                self.logger.info("[cdp-proxy] Chrome WS auto-reconnected")
                return
            } catch is CancellationError {
                return
            } catch {
                self.logger.warning("[cdp-proxy] Auto-reconnect failed: \(String(describing: error))")
            }
        }
    }

    private static func defaultChromeConnector(
        url: String,
        maxFrameSize: Int,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) async throws -> ChromeSocketHandle {
        let messagePump = ChromeInboundMessagePump(
            maxBufferedMessages: Self.defaultChromeInboundMessageBufferLimit
        )
        let messagePumpTask = Task {
            await Self.runChromeMessagePump(messagePump, onMessage: onMessage)
        }
        let terminationState = ChromeSocketTerminationState()
        let (socketStream, socketContinuation) = AsyncStream<WebSocket>.makeStream()
        let connectFuture = WebSocket.connect(
            to: url,
            configuration: .init(maxFrameSize: maxFrameSize),
            on: HTTPClient.defaultEventLoopGroup
        ) { socket in
            socket.onText { _, text in
                let result = messagePump.enqueue(.text(text))
                if case .overflow = result,
                   terminationState.markOverflow(
                       reason: "Inbound Chrome frame buffer overflowed (\(Self.defaultChromeInboundMessageBufferLimit) queued messages)"
                   ) {
                    Task {
                        try? await socket.close(code: .messageTooLarge)
                    }
                }
            }
            socket.onBinary { _, buffer in
                let result = messagePump.enqueue(.binary(buffer))
                if case .overflow = result,
                   terminationState.markOverflow(
                       reason: "Inbound Chrome frame buffer overflowed (\(Self.defaultChromeInboundMessageBufferLimit) queued messages)"
                   ) {
                    Task {
                        try? await socket.close(code: .messageTooLarge)
                    }
                }
            }
            socket.onClose.whenComplete { result in
                Task {
                    await Self.handleChromeSocketTermination(
                        messagePump: messagePump,
                        messagePumpTask: messagePumpTask,
                        result: result,
                        closeDescription: "code=\(String(describing: socket.closeCode))",
                        overflowDescription: terminationState.overflowDescriptionSnapshot(),
                        onEvent: onEvent
                    )
                }
            }

            socketContinuation.yield(socket)
            socketContinuation.finish()
        }

        do {
            try await connectFuture.get()
        } catch {
            socketContinuation.finish()
            messagePump.finish()
            _ = await messagePumpTask.value
            throw error
        }

        var iterator = socketStream.makeAsyncIterator()
        guard let socket = await iterator.next() else {
            throw CDPProxyError.discoveryFailed("WebSocket upgrade completed without a Chrome socket")
        }

        return ChromeSocketHandle(
            send: { message in
                switch message {
                case .text(let text):
                    try await socket.send(text)
                case .binary(let buffer):
                    try await socket.send(raw: buffer.readableBytesView, opcode: .binary)
                }
            },
            close: {
                messagePump.finish()
                try? await socket.close(code: .goingAway)
                _ = await messagePumpTask.value
            },
            isOpen: {
                !socket.isClosed
            }
        )
    }

    // MARK: - WebKit Pipe Bridge

    /// Start reading from the WebKit inspector pipe on a background task.
    /// Accumulates data, splits on null bytes, and forwards each JSON message
    /// to the active WebSocket client.
    private func startPipeReader() {
        guard let pipeRead else { return }

        self.pipeReadTask = Task { [weak self] in
            pipeRead.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else {
                    // EOF — pipe closed
                    pipeRead.readabilityHandler = nil
                    return
                }
                Task {
                    guard let self else { return }
                    await self.handlePipeData(data)
                }
            }

            // Keep this task alive until cancelled
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            pipeRead.readabilityHandler = nil
        }
    }

    /// Process incoming data from the WebKit pipe, splitting on null bytes.
    private func handlePipeData(_ data: Data) async {
        pipeBuffer.append(data)

        while let nullIdx = pipeBuffer.firstIndex(of: 0) {
            let frame = pipeBuffer.subdata(in: pipeBuffer.startIndex..<nullIdx)
            pipeBuffer.removeSubrange(pipeBuffer.startIndex...nullIdx)
            guard !frame.isEmpty else { continue }
            let raw = String(decoding: frame, as: UTF8.self)
            guard !raw.isEmpty else { continue }

            let preview = String(raw.prefix(200))
            let logLine = "[cdp-proxy] WebKit→Client: \(preview)"
            if self.logDedup.shouldLog(logLine) {
                self.logger.debug("\(logLine)")
            }

            if let activeClient {
                do {
                    try await activeClient.send(.text(raw))
                } catch {
                    self.logger.error("[cdp-proxy] Client WS error: \(String(describing: error))")
                    if self.activeClient?.id == activeClient.id {
                        self.activeClient = nil
                    }
                }
            }
        }
    }

    /// Handle a WebSocket client connection in pipe mode.
    /// Messages from the client are forwarded to the WebKit pipe;
    /// messages from the pipe are forwarded to the client (via startPipeReader).
    private func handlePipeClientConnection(
        inbound: WebSocketInboundStream,
        outbound: WebSocketOutboundWriter
    ) async throws {
        let client = ClientHandle(
            send: { message in
                switch message {
                case .text(let text):
                    try await outbound.write(.text(text))
                case .binary(let buffer):
                    try await outbound.write(.binary(buffer))
                }
            },
            close: { code, reason in
                try? await outbound.close(code, reason: reason)
            }
        )

        await self.addClient(client)
        let clientID = client.id

        do {
            var iterator = inbound.makeAsyncIterator()
            while let message = try await iterator.nextMessage(maxSize: self.maxMessageSize) {
                let text: String
                switch ProxyMessage(message) {
                case .text(let t):
                    text = t
                case .binary(let buffer):
                    text = String(decoding: Data(buffer.readableBytesView), as: UTF8.self)
                }

                let preview = String(text.prefix(200))
                let logLine = "[cdp-proxy] Client→WebKit: \(preview)"
                if self.logDedup.shouldLog(logLine) {
                    self.logger.debug("\(logLine)")
                }

                self.writeToPipe(text)
            }
            await self.removeClient(id: clientID, reason: "[cdp-proxy] Client disconnected")
        } catch {
            self.logger.error("[cdp-proxy] Client WS error: \(String(describing: error))")
            await self.removeClient(id: clientID, reason: "[cdp-proxy] Client disconnected")
        }
    }
}

extension CDPProxy {
    static func runChromeMessagePump(
        _ messagePump: ChromeInboundMessagePump,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void
    ) async {
        while let message = await messagePump.next() {
            await onMessage(message)
        }
    }

    static func handleChromeSocketTermination(
        messagePump: ChromeInboundMessagePump,
        messagePumpTask: Task<Void, Never>,
        result: Result<Void, Error>,
        closeDescription: String,
        overflowDescription: String?,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) async {
        messagePump.finish()
        _ = await messagePumpTask.value

        if let overflowDescription {
            await onEvent(.error(overflowDescription))
            return
        }

        switch result {
        case .success:
            await onEvent(.closed(closeDescription))
        case .failure(let error):
            await onEvent(.error(String(describing: error)))
        }
    }
}

final class ChromeInboundMessagePump: @unchecked Sendable {
    enum EnqueueResult: Equatable {
        case enqueued
        case overflow
        case terminated
    }

    private enum NextState {
        case message(ProxyMessage)
        case finished
        case wait
    }

    private let maxBufferedMessages: Int
    private let stateQueue = DispatchQueue(label: "slicc.cdp-proxy.chrome-inbound-pump")
    private var buffer: [ProxyMessage] = []
    private var pendingContinuation: CheckedContinuation<ProxyMessage?, Never>?
    private var isFinished = false

    init(maxBufferedMessages: Int = CDPProxy.defaultChromeInboundMessageBufferLimit) {
        self.maxBufferedMessages = max(1, maxBufferedMessages)
    }

    func enqueue(_ message: ProxyMessage) -> EnqueueResult {
        var continuation: CheckedContinuation<ProxyMessage?, Never>?
        let result = self.stateQueue.sync { () -> EnqueueResult in
            guard !self.isFinished else {
                return .terminated
            }

            if let pendingContinuation = self.pendingContinuation {
                self.pendingContinuation = nil
                continuation = pendingContinuation
                return .enqueued
            }

            guard self.buffer.count < self.maxBufferedMessages else {
                self.isFinished = true
                return .overflow
            }

            self.buffer.append(message)
            return .enqueued
        }

        continuation?.resume(returning: message)
        return result
    }

    func next() async -> ProxyMessage? {
        switch self.nextState() {
        case .message(let message):
            return message
        case .finished:
            return nil
        case .wait:
            return await withCheckedContinuation { continuation in
                var nextState: NextState?

                self.stateQueue.sync {
                    if !self.buffer.isEmpty {
                        nextState = .message(self.buffer.removeFirst())
                        return
                    }

                    if self.isFinished {
                        nextState = .finished
                        return
                    }

                    self.pendingContinuation = continuation
                }

                switch nextState {
                case .message(let message):
                    continuation.resume(returning: message)
                case .finished:
                    continuation.resume(returning: nil)
                case .wait, .none:
                    break
                }
            }
        }
    }

    func finish() {
        var continuation: CheckedContinuation<ProxyMessage?, Never>?

        self.stateQueue.sync {
            guard !self.isFinished else {
                return
            }

            self.isFinished = true
            continuation = self.pendingContinuation
            self.pendingContinuation = nil
        }

        continuation?.resume(returning: nil)
    }

    private func nextState() -> NextState {
        self.stateQueue.sync {
            if !self.buffer.isEmpty {
                return .message(self.buffer.removeFirst())
            }

            if self.isFinished {
                return .finished
            }

            return .wait
        }
    }
}

final class ChromeSocketTerminationState: @unchecked Sendable {
    private let lock = NSLock()
    private var overflowDescription: String?

    func markOverflow(reason: String) -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }

        guard self.overflowDescription == nil else {
            return false
        }

        self.overflowDescription = reason
        return true
    }

    func overflowDescriptionSnapshot() -> String? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.overflowDescription
    }
}

struct ClientHandle: Sendable {
    let id: UUID
    let send: @Sendable (ProxyMessage) async throws -> Void
    let close: @Sendable (WebSocketErrorCode, String?) async -> Void

    init(
        id: UUID = UUID(),
        send: @escaping @Sendable (ProxyMessage) async throws -> Void,
        close: @escaping @Sendable (WebSocketErrorCode, String?) async -> Void
    ) {
        self.id = id
        self.send = send
        self.close = close
    }
}

struct ChromeSocketHandle: Sendable {
    let send: @Sendable (ProxyMessage) async throws -> Void
    let close: @Sendable () async -> Void
    let isOpen: @Sendable () -> Bool
}

typealias ChromeSocketConnector = @Sendable (
    String,
    @escaping @Sendable (ProxyMessage) async -> Void,
    @escaping @Sendable (ChromeSocketEvent) async -> Void
) async throws -> ChromeSocketHandle

enum ChromeSocketEvent: Sendable {
    case closed(String)
    case error(String)
}

enum ProxyMessage: Sendable {
    case text(String)
    case binary(ByteBuffer)

    init(_ message: WebSocketMessage) {
        switch message {
        case .text(let text):
            self = .text(text)
        case .binary(let buffer):
            self = .binary(buffer)
        }
    }

    var preview: String {
        switch self {
        case .text(let text):
            return String(text.prefix(200))
        case .binary(let buffer):
            return "<binary \(buffer.readableBytes) bytes>"
        }
    }
}

enum CDPProxyError: Error, Sendable, LocalizedError {
    case discoveryFailed(String)

    var errorDescription: String? {
        switch self {
        case .discoveryFailed(let description):
            return description
        }
    }
}

private struct CDPVersionPayload: Decodable, Sendable {
    let webSocketDebuggerUrl: String
}
