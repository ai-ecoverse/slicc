import Foundation

protocol CDPBrowserSession: Sendable {

    func call(method: String) async throws -> Data
    func close() async
}

enum CDPBrowserSessionError: LocalizedError {
    case noReply(method: String)

    var errorDescription: String? {
        switch self {
        case .noReply(let method):
            return "The browser did not reply to \(method)."
        }
    }
}

protocol CDPWebSocketTransport: Sendable {
    func sendFrame(_ payload: Data) async throws
    func receiveFrame() async throws -> URLSessionWebSocketTask.Message
    func cancelSocket() async
}

final class URLSessionCDPWebSocket: CDPWebSocketTransport, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(url: URL, session: URLSession) {
        task = session.webSocketTask(with: url)
        task.resume()
    }

    func sendFrame(_ payload: Data) async throws {
        try await task.send(.data(payload))
    }

    func receiveFrame() async throws -> URLSessionWebSocketTask.Message {
        try await task.receive()
    }

    func cancelSocket() {
        task.cancel(with: .goingAway, reason: nil)
    }
}

actor WebSocketCDPBrowserSession: CDPBrowserSession {

    private static let maxFramesPerCall = 64

    private let socket: any CDPWebSocketTransport
    private var nextId = 0

    init(url: URL, session: URLSession = .shared) {
        socket = URLSessionCDPWebSocket(url: url, session: session)
    }

    init(socket: any CDPWebSocketTransport) {
        self.socket = socket
    }

    func call(method: String) async throws -> Data {
        nextId += 1
        let id = nextId
        let payload = try JSONSerialization.data(withJSONObject: ["id": id, "method": method])
        try await socket.sendFrame(payload)

        for _ in 0..<Self.maxFramesPerCall {
            guard let frame = Self.payload(of: try await socket.receiveFrame()),
                let result = Self.result(fromFrame: frame, id: id)
            else { continue }
            return result
        }
        throw CDPBrowserSessionError.noReply(method: method)
    }

    func close() async {
        await socket.cancelSocket()
    }

    static func result(fromFrame frame: Data, id: Int) -> Data? {
        guard let object = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
            object["id"] as? Int == id
        else { return nil }
        return try? JSONSerialization.data(withJSONObject: object["result"] as? [String: Any] ?? [:])
    }

    private static func payload(of message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case .data(let payload):
            return payload
        case .string(let text):
            return Data(text.utf8)
        @unknown default:
            return nil
        }
    }
}
