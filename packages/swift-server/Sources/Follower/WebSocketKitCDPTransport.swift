import AsyncHTTPClient
import Foundation
import NIOCore
import WebSocketKit

// A `CDPWebSocketTransport` backed by WebSocketKit (NIO) — the same WS client
// `CDPProxy` uses, and the one that actually completes the WebSocket handshake
// against Electron/Chrome DevTools. `URLSessionWebSocketTask` silently fails
// that handshake against Electron's raw CDP endpoint (the socket never connects,
// so `receive()` throws "Socket is not connected"), which the mock transport in
// the servicer's unit tests could not surface — this was caught live driving
// Signal. The federated-CDP servicer uses this transport in production; tests
// still inject a double via `connect(transport:)`.

enum WebSocketKitCDPTransportError: LocalizedError {
    case noSocket

    var errorDescription: String? {
        switch self {
        case .noSocket: return "WebSocket upgrade completed without a socket"
        }
    }
}

/// Raised by `receiveFrame()` when the app's CDP socket has closed — the
/// servicer treats it as a lost socket.
struct CDPSocketClosedError: LocalizedError {
    var errorDescription: String? { "app CDP socket closed" }
}

/// Thread-safe inbound-frame buffer bridging WebSocketKit's event-loop callbacks
/// (`onText`/`onBinary`/`onClose`) to the servicer's `await receiveFrame()`.
private final class WSMessageBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [URLSessionWebSocketTask.Message] = []
    private var waiter: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var closed = false

    func push(_ message: URLSessionWebSocketTask.Message) {
        lock.lock()
        if let waiter = waiter {
            self.waiter = nil
            lock.unlock()
            waiter.resume(returning: message)
        } else {
            queue.append(message)
            lock.unlock()
        }
    }

    func close() {
        lock.lock()
        closed = true
        let waiter = self.waiter
        self.waiter = nil
        lock.unlock()
        waiter?.resume(throwing: CDPSocketClosedError())
    }

    func next() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !queue.isEmpty {
                let message = queue.removeFirst()
                lock.unlock()
                continuation.resume(returning: message)
            } else if closed {
                lock.unlock()
                continuation.resume(throwing: CDPSocketClosedError())
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }
}

final class WebSocketKitCDPTransport: CDPWebSocketTransport, @unchecked Sendable {
    /// CDP results (e.g. `Page.captureScreenshot`) can be many MB; match the
    /// proxy's generous inbound frame cap so a big reply is not dropped.
    static let maxFrameSize = 64 * 1024 * 1024

    private let socket: WebSocket
    private let buffer: WSMessageBuffer

    private init(socket: WebSocket, buffer: WSMessageBuffer) {
        self.socket = socket
        self.buffer = buffer
    }

    /// Open a WebSocket to the app's browser-level CDP endpoint. Awaits the
    /// handshake, so a failure is reported here rather than on the first send.
    static func connect(
        url: String,
        on eventLoopGroup: EventLoopGroup = HTTPClient.defaultEventLoopGroup
    ) async throws -> WebSocketKitCDPTransport {
        let buffer = WSMessageBuffer()
        let (sockets, socketContinuation) = AsyncStream<WebSocket>.makeStream()

        let connectFuture = WebSocket.connect(
            to: url,
            configuration: .init(maxFrameSize: maxFrameSize),
            on: eventLoopGroup
        ) { socket in
            socket.onText { _, text in buffer.push(.string(text)) }
            socket.onBinary { _, byteBuffer in buffer.push(.data(Data(byteBuffer.readableBytesView))) }
            socket.onClose.whenComplete { _ in buffer.close() }
            socketContinuation.yield(socket)
            socketContinuation.finish()
        }

        do {
            try await connectFuture.get()
        } catch {
            buffer.close()
            socketContinuation.finish()
            throw error
        }

        var socketIterator = sockets.makeAsyncIterator()
        guard let socket = await socketIterator.next() else {
            buffer.close()
            throw WebSocketKitCDPTransportError.noSocket
        }
        return WebSocketKitCDPTransport(socket: socket, buffer: buffer)
    }

    // CDP frames are JSON text; send as text (Chrome/Electron reply with text).
    func sendFrame(_ payload: Data) async throws {
        try await socket.send(String(decoding: payload, as: UTF8.self))
    }

    func receiveFrame() async throws -> URLSessionWebSocketTask.Message {
        try await buffer.next()
    }

    func cancelSocket() async {
        try? await socket.close(code: .goingAway)
    }
}
