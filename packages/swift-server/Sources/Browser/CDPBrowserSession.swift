import Foundation

/// A request/response channel to the *browser*-level CDP endpoint
/// (`/devtools/browser/<id>`, discovered through `/json/version`).
///
/// The browser endpoint is used rather than a page target because Chrome
/// multiplexes browser-level clients: attaching here cannot evict the `/cdp`
/// session the webapp owns. Verified against Chrome — two browser-level
/// clients plus a live page session coexist, and the page session keeps
/// answering `Runtime.evaluate` while the browser clients poll.
protocol CDPBrowserSession: Sendable {
    /// Send a parameterless CDP command and return its `result` object.
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

/// The socket operations the session needs. `URLSessionWebSocketTask` supplies
/// them in production; tests supply a double, which is the only way to drive
/// the frame-matching loop without a live browser.
protocol CDPWebSocketTransport: Sendable {
    func sendFrame(_ payload: Data) async throws
    func receiveFrame() async throws -> URLSessionWebSocketTask.Message
    func cancelSocket() async
}

/// `URLSessionWebSocketTask` is documented as safe to use from any thread.
/// Internal (not private) so the federated-CDP servicer can reuse it as its
/// production transport rather than duplicating the URLSession glue.
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

/// `URLSessionWebSocketTask`-backed `CDPBrowserSession`. One instance is one
/// short-lived connection: callers open it, make their reads, and close it,
/// so there is no reconnect state to manage and a dropped connection simply
/// means the next read reconnects.
actor WebSocketCDPBrowserSession: CDPBrowserSession {
    /// Browser-level target lifecycle events interleave with command replies,
    /// so a read loop has to skip frames until the matching `id` shows up.
    /// Bounded so a chatty browser cannot pin the caller forever.
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

    /// The `result` object of `frame` when it is the reply to `id`, else `nil`
    /// — an event, another call's reply, or a non-JSON frame.
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
