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
    static let defaultMaxMessageSize = 16 * 1024 * 1024

    private let logger: Logger
    private let logDedup: CliLogDedup
    private let discoverer: @Sendable (Int) async throws -> String
    private let chromeConnector: ChromeSocketConnector
    private let maxMessageSize: Int

    private var cachedCDPPort: Int?
    private var cachedCDPURL: String?
    private var chromeSocket: ChromeSocketHandle?
    private var chromeConnectionID: UUID?
    private var chromeConnectionTask: Task<ChromeSocketHandle, Error>?
    private var activeClient: ClientHandle?
    private var messageBuffer: [ProxyMessage]?

    init(
        logger: Logger = Logger(label: "slicc.cdp-proxy"),
        maxMessageSize: Int = CDPProxy.defaultMaxMessageSize,
        discoverer: (@Sendable (Int) async throws -> String)? = nil,
        chromeConnector: ChromeSocketConnector? = nil
    ) {
        self.logger = logger
        self.maxMessageSize = maxMessageSize
        self.discoverer = discoverer ?? Self.defaultDiscoverCDPURL(port:)
        self.chromeConnector = chromeConnector ?? Self.defaultChromeConnector(url:onMessage:onEvent:)
        self.logDedup = CliLogDedup(prefix: "[cdp-proxy]", sink: { summary in
            logger.debug("\(summary)")
        })
    }

    func install(on router: Router<BasicWebSocketRequestContext>, cdpPort: Int) {
        router.ws("/cdp") { _, _ in
            .upgrade([:])
        } onUpgrade: { inbound, outbound, context in
            try await self.handleClientConnection(
                inbound: inbound,
                outbound: outbound,
                context: context,
                cdpPort: cdpPort
            )
        }
    }

    func preWarm(cdpPort: Int) async throws {
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
                self.chromeSocket = nil
                self.logger.error("[cdp-proxy] Chrome WS error: \(String(describing: error))")
            }
        } else if self.messageBuffer != nil {
            self.messageBuffer?.append(message)
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

    private func cdpURL(for port: Int) async throws -> String {
        if self.cachedCDPPort == port, let cachedCDPURL {
            return cachedCDPURL
        }

        let discoveredURL = try await self.discoverer(port)
        self.cachedCDPPort = port
        self.cachedCDPURL = discoveredURL
        self.logger.info("[cdp-proxy] CDP available at: \(discoveredURL)")
        return discoveredURL
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
        case .error(let description):
            self.logger.error("[cdp-proxy] Chrome WS error: \(description)")
        }

        self.chromeSocket = nil
        self.chromeConnectionTask = nil
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

    private static func defaultChromeConnector(
        url: String,
        onMessage: @escaping @Sendable (ProxyMessage) async -> Void,
        onEvent: @escaping @Sendable (ChromeSocketEvent) async -> Void
    ) async throws -> ChromeSocketHandle {
        let socketCapture = LockedValue<WebSocket>()
        let connectFuture = WebSocket.connect(to: url, on: HTTPClient.defaultEventLoopGroup) { socket in
            socketCapture.set(socket)
            socket.onText { _, text in
                Task {
                    await onMessage(.text(text))
                }
            }
            socket.onBinary { _, buffer in
                Task {
                    await onMessage(.binary(buffer))
                }
            }
            socket.onClose.whenComplete { result in
                Task {
                    switch result {
                    case .success:
                        let description = "code=\(String(describing: socket.closeCode))"
                        await onEvent(.closed(description))
                    case .failure(let error):
                        await onEvent(.error(String(describing: error)))
                    }
                }
            }
        }

        try await connectFuture.get()
        guard let socket = socketCapture.get() else {
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
                try? await socket.close(code: .goingAway)
            },
            isOpen: {
                !socket.isClosed
            }
        )
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

private final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value?

    init(_ value: Value? = nil) {
        self.value = value
    }

    func set(_ value: Value) {
        self.lock.lock()
        self.value = value
        self.lock.unlock()
    }

    func get() -> Value? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.value
    }
}